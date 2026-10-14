import { spawn, type ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { MAX_STDIN_PAYLOAD_BYTES } from "../src/process-manager.js";
import { delay, fakeChild, managerFor, nodeCommand, processConfig, waitFor } from "./helpers/process-manager.js";

describe("ProcessManager", () => {
  it("starts a short-lived process and records stopped status", async () => {
    const process = processConfig({ command: nodeCommand("console.log('ready')") });
    const { manager, stdout } = managerFor([process]);

    await manager.start("api");
    await waitFor(() => manager.getStatus()[0]?.state === "stopped");

    expect(stdout.value).toContain("api | ready\n");
    expect(manager.getStatus()[0]).toMatchObject({
      name: "api",
      state: "stopped",
      lastExitCode: 0
    });
  });

  it("stops a running process", async () => {
    const process = processConfig();
    const { manager } = managerFor([process]);

    await manager.start("api");
    expect(manager.getStatus()[0]?.state).toBe("running");
    await manager.stop("api");

    expect(manager.getStatus()[0]?.state).toBe("stopped");
  });

  it("does not report stopped if tree killing fails and the child never exits", async () => {
    let spawnCount = 0;
    const spawnProcess = (() => {
      spawnCount += 1;
      return fakeChild(9000 + spawnCount);
    }) as typeof spawn;
    const { manager } = managerFor([processConfig()], {
      spawnProcess,
      stopTimeoutMs: 20,
      killProcessTree: async () => {
        throw new Error("taskkill failed");
      }
    });

    await manager.start("api");
    await expect(manager.restart("api")).rejects.toThrow(/did not stop cleanly/);

    const status = manager.getStatus()[0];
    expect(spawnCount).toBe(1);
    expect(status?.state).toBe("failed");
    expect(status?.pid).toBe(9001);
    expect(status?.lastError).toContain("taskkill failed");
  });

  it("restarts a process and increments restart count", async () => {
    const process = processConfig();
    const { manager } = managerFor([process]);

    await manager.start("api");
    await manager.restart("api");

    const status = manager.getStatus()[0];
    expect(status?.state).toBe("running");
    expect(status?.restartCount).toBe(1);
    await manager.stop("api");
  });

  it("sends newline-terminated input to stdin-enabled processes", async () => {
    const child = fakeChild(9350, { stdin: true });
    let input = "";
    child.stdin?.on("data", (chunk: Buffer) => {
      input += chunk.toString();
    });
    const { manager } = managerFor([processConfig({ stdin: true })], {
      spawnProcess: (() => child) as typeof spawn
    });

    await manager.start("api");
    await manager.send("api", "rs");

    expect(input).toBe("rs\n");
  });

  it("rejects sends when stdin is disabled", async () => {
    const { manager } = managerFor([processConfig()]);

    await manager.start("api");

    await expect(manager.send("api", "rs")).rejects.toThrow(/stdin enabled/);
    await manager.stop("api");
  });

  it("rejects sends to stopped processes", async () => {
    const { manager } = managerFor([processConfig({ stdin: true })]);

    await expect(manager.send("api", "rs")).rejects.toThrow(/not running/);
  });

  it("rejects sends when stdin is closed", async () => {
    const child = fakeChild(9351, { stdin: true });
    const { manager } = managerFor([processConfig({ stdin: true })], {
      spawnProcess: (() => child) as typeof spawn
    });

    await manager.start("api");
    child.stdin?.destroy();

    await expect(manager.send("api", "rs")).rejects.toThrow(/stdin is not writable/);
  });

  it("rejects oversized stdin payloads", async () => {
    const { manager } = managerFor([processConfig({ stdin: true })]);

    await expect(manager.send("api", "x".repeat(MAX_STDIN_PAYLOAD_BYTES + 1))).rejects.toThrow(
      /too large/
    );
  });

  it("waits for tree cleanup and output closure before spawning a restart replacement", async () => {
    const events: string[] = [];
    const children = new Map<number, ChildProcess>();
    let nextPid = 9100;
    const spawnProcess = (() => {
      const pid = nextPid;
      nextPid += 1;
      events.push(`spawn:${pid}`);
      const child = fakeChild(pid);
      children.set(pid, child);
      return child;
    }) as typeof spawn;
    const { manager } = managerFor([processConfig()], {
      spawnProcess,
      killProcessTree: async (pid) => {
        events.push(`kill:${pid}`);
        await delay(20);
        events.push(`exit:${pid}`);
        children.get(pid)?.emit("exit", null, "SIGTERM");
        setTimeout(() => {
          events.push(`close:${pid}`);
          children.get(pid)?.emit("close", null, "SIGTERM");
        }, 20);
      }
    });

    await manager.start("api");
    await manager.restart("api");

    expect(events).toEqual(["spawn:9100", "kill:9100", "exit:9100", "close:9100", "spawn:9101"]);
  });

  it("shares an in-flight stop during repeated shutdown requests", async () => {
    const child = fakeChild(9200);
    let killCalls = 0;
    const { manager } = managerFor([processConfig()], {
      spawnProcess: (() => child) as typeof spawn,
      killProcessTree: async () => {
        killCalls += 1;
        await delay(20);
        child.emit("close", null, "SIGTERM");
      }
    });

    await manager.start("api");
    await Promise.all([manager.stopAll(), manager.stopAll()]);

    expect(killCalls).toBe(1);
    expect(manager.getStatus()[0]?.state).toBe("stopped");
  });

  it("cancels delayed starts when shutdown begins", async () => {
    let spawnCount = 0;
    const { manager } = managerFor(
      [
        processConfig({
          startupDelayMs: 100
        })
      ],
      {
        spawnProcess: (() => {
          spawnCount += 1;
          return fakeChild(9300);
        }) as typeof spawn
      }
    );

    const startPromise = manager.start("api");
    await delay(10);
    await manager.stopAll();
    await startPromise;

    expect(spawnCount).toBe(0);
    expect(manager.getStatus()[0]?.state).toBe("stopped");
  });

  it("reports unknown process names with available names", async () => {
    const { manager } = managerFor([processConfig()]);

    await expect(manager.start("web")).rejects.toThrow(/Available processes: api/);
  });

  it("tracks automatic restarts", async () => {
    const process = processConfig({
      restart: "on-failure",
      command: nodeCommand("process.exit(7)")
    });
    const { manager } = managerFor([process]);

    await manager.start("api");
    await waitFor(() => (manager.getStatus()[0]?.restartCount ?? 0) > 0);
    await manager.stop("api");

    expect(manager.getStatus()[0]?.restartCount).toBeGreaterThan(0);
  });

  it("uses exponential restart backoff capped by config", async () => {
    vi.useFakeTimers();
    try {
      const children: ChildProcess[] = [];
      let nextPid = 9400;
      const spawnProcess = (() => {
        const child = fakeChild(nextPid);
        nextPid += 1;
        children.push(child);
        return child;
      }) as typeof spawn;
      const { manager } = managerFor(
        [
          processConfig({
            restart: "always",
            restartBackoffMs: 10,
            restartBackoffMaxMs: 25
          })
        ],
        { spawnProcess }
      );

      await manager.start("api");
      children[0]?.emit("close", 1, null);
      await vi.advanceTimersByTimeAsync(9);
      expect(children).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(children).toHaveLength(2);

      children[1]?.emit("close", 1, null);
      await vi.advanceTimersByTimeAsync(19);
      expect(children).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(children).toHaveLength(3);

      children[2]?.emit("close", 1, null);
      await vi.advanceTimersByTimeAsync(24);
      expect(children).toHaveLength(3);
      await vi.advanceTimersByTimeAsync(1);
      expect(children).toHaveLength(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops restarting after max automatic attempts", async () => {
    vi.useFakeTimers();
    try {
      const children: ChildProcess[] = [];
      const spawnProcess = (() => {
        const child = fakeChild(9500 + children.length);
        children.push(child);
        return child;
      }) as typeof spawn;
      const { manager } = managerFor(
        [
          processConfig({
            restart: "always",
            restartBackoffMs: 1,
            restartBackoffMaxMs: 1,
            restartMaxAttempts: 1
          })
        ],
        { spawnProcess }
      );

      await manager.start("api");
      children[0]?.emit("close", 1, null);
      await vi.advanceTimersByTimeAsync(1);
      expect(children).toHaveLength(2);

      children[1]?.emit("close", 1, null);

      const status = manager.getStatus()[0];
      expect(status?.state).toBe("failed");
      expect(status?.lastError).toContain("Restart limit reached");
      expect(children).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resets automatic restart backoff after a stable run", async () => {
    vi.useFakeTimers();
    try {
      let now = 0;
      const children: ChildProcess[] = [];
      const spawnProcess = (() => {
        const child = fakeChild(9600 + children.length);
        children.push(child);
        return child;
      }) as typeof spawn;
      const { manager } = managerFor(
        [
          processConfig({
            restart: "always",
            restartBackoffMs: 10,
            restartBackoffResetMs: 50
          })
        ],
        { spawnProcess, now: () => now }
      );

      await manager.start("api");
      children[0]?.emit("close", 1, null);
      await vi.advanceTimersByTimeAsync(10);
      expect(children).toHaveLength(2);

      now = 100;
      children[1]?.emit("close", 1, null);
      await vi.advanceTimersByTimeAsync(9);
      expect(children).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(children).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels pending automatic restarts when stopped manually", async () => {
    vi.useFakeTimers();
    try {
      const children: ChildProcess[] = [];
      const spawnProcess = (() => {
        const child = fakeChild(9700 + children.length);
        children.push(child);
        return child;
      }) as typeof spawn;
      const { manager } = managerFor(
        [
          processConfig({
            restart: "always",
            restartBackoffMs: 100
          })
        ],
        { spawnProcess }
      );

      await manager.start("api");
      children[0]?.emit("close", 1, null);
      await manager.stop("api");
      await vi.advanceTimersByTimeAsync(100);

      expect(children).toHaveLength(1);
      expect(manager.getStatus()[0]?.state).toBe("stopped");
    } finally {
      vi.useRealTimers();
    }
  });
});
