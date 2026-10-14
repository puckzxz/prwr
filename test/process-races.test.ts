import { spawn, type ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { waitForClose } from "../src/process-io.js";
import { fakeChild, managerFor, processConfig } from "./helpers/process-manager.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function controlledManager() {
  const children: ChildProcess[] = [];
  const killing = deferred();
  const killed = deferred();
  const killCalls: number[] = [];
  const { manager } = managerFor([processConfig()], {
    spawnProcess: (() => {
      const child = fakeChild(10000 + children.length);
      children.push(child);
      return child;
    }) as typeof spawn,
    killProcessTree: async (pid) => {
      killCalls.push(pid);
      killing.resolve();
      await killed.promise;
      children.find((child) => child.pid === pid)?.emit("close", null, "SIGTERM");
    }
  });
  return { manager, children, killing, killed, killCalls };
}

describe("process lifecycle races", () => {
  it("waits for the spawn event before reporting running", async () => {
    const child = fakeChild(10100, { autoSpawn: false });
    const { manager } = managerFor([processConfig()], {
      spawnProcess: (() => child) as typeof spawn,
      killProcessTree: async () => { child.emit("close", null, "SIGTERM"); }
    });
    try {
      const starting = manager.start("api");
      expect(manager.getStatus()[0]?.state).toBe("starting");
      child.emit("spawn");
      expect(await starting).toMatchObject({ state: "running", pid: 10100 });
    } finally {
      await manager.stopAll();
    }
  });

  it("shares a pending start without spawning a second child", async () => {
    const child = fakeChild(10101, { autoSpawn: false });
    const spawnProcess = vi.fn(() => child);
    const { manager } = managerFor([processConfig()], {
      spawnProcess: spawnProcess as unknown as typeof spawn,
      killProcessTree: async () => { child.emit("close", null, "SIGTERM"); }
    });
    try {
      const first = manager.start("api");
      const second = manager.start("api");
      child.emit("spawn");
      expect((await Promise.all([first, second])).map((status) => status.state)).toEqual(["running", "running"]);
      expect(spawnProcess).toHaveBeenCalledTimes(1);
    } finally {
      await manager.stopAll();
    }
  });

  it("shares concurrent restarts and kills the old tree once", async () => {
    const { manager, children, killing, killed, killCalls } = controlledManager();
    try {
      await manager.start("api");
      const first = manager.restart("api");
      const second = manager.restart("api");
      await killing.promise;
      expect(children).toHaveLength(1);
      killed.resolve();
      expect((await Promise.all([first, second])).map((status) => status.state)).toEqual(["running", "running"]);
      expect(children).toHaveLength(2);
      expect(killCalls).toEqual([10000]);
      expect(manager.getStatus()[0]?.restartCount).toBe(1);
    } finally {
      killed.resolve();
      await manager.stopAll();
    }
  });

  it.each(["stop", "down"])("lets a later %s cancel a restart waiting for cleanup", async (action) => {
    const { manager, children, killing, killed } = controlledManager();
    try {
      await manager.start("api");
      const restarting = manager.restart("api");
      await killing.promise;
      const stopping = action === "stop" ? manager.stop("api") : manager.stopAll();
      killed.resolve();
      await stopping;
      expect(await restarting).toMatchObject({ state: "stopped", pid: null });
      expect(children).toHaveLength(1);
    } finally {
      killed.resolve();
      await manager.stopAll();
    }
  });

  it("lets a later stop cancel a start waiting for cleanup", async () => {
    const { manager, children, killing, killed } = controlledManager();
    try {
      await manager.start("api");
      const firstStop = manager.stop("api");
      await killing.promise;
      const starting = manager.start("api");
      const secondStop = manager.stop("api");
      killed.resolve();
      await Promise.all([firstStop, secondStop]);
      expect(await starting).toMatchObject({ state: "stopped", pid: null });
      expect(children).toHaveLength(1);
    } finally {
      killed.resolve();
      await manager.stopAll();
    }
  });

  it("allows an explicit new start after a stop request to wait for cleanup", async () => {
    const { manager, children, killing, killed } = controlledManager();
    try {
      await manager.start("api");
      const stopping = manager.stop("api");
      await killing.promise;
      const starting = manager.start("api");
      expect(children).toHaveLength(1);
      killed.resolve();
      await stopping;
      expect(await starting).toMatchObject({ state: "running", pid: 10001 });
      expect(children).toHaveLength(2);
    } finally {
      killed.resolve();
      await manager.stopAll();
    }
  });

  it("honors a new restart after a stop cancelled an earlier restart", async () => {
    const { manager, children, killing, killed } = controlledManager();
    try {
      await manager.start("api");
      const cancelledRestart = manager.restart("api");
      await killing.promise;
      const stopping = manager.stop("api");
      const newRestart = manager.restart("api");
      killed.resolve();
      await Promise.all([cancelledRestart, stopping]);
      expect(await newRestart).toMatchObject({ state: "running", pid: 10001, restartCount: 2 });
      expect(children).toHaveLength(2);
    } finally {
      killed.resolve();
      await manager.stopAll();
    }
  });

  it("cancels an unspawned delayed start on manual stop", async () => {
    const spawnProcess = vi.fn(() => fakeChild(10200));
    const { manager } = managerFor([processConfig({ startupDelayMs: 10000, restart: "always" })], {
      spawnProcess: spawnProcess as unknown as typeof spawn
    });
    const starting = manager.start("api");
    expect(manager.getStatus()[0]?.state).toBe("starting");
    await manager.stop("api");
    expect(await starting).toMatchObject({ state: "stopped", pid: null, restartCount: 0 });
    expect(spawnProcess).not.toHaveBeenCalled();
    await manager.stopAll();
  });

  it("applies bounded restart policy to asynchronous spawn failures", async () => {
    vi.useFakeTimers();
    const children: ChildProcess[] = [];
    const { manager } = managerFor([processConfig({ restart: "on-failure", restartBackoffMs: 1, restartMaxAttempts: 1 })], {
      spawnProcess: (() => {
        const child = fakeChild(0, { autoSpawn: false });
        Object.assign(child, { pid: undefined });
        children.push(child);
        void Promise.resolve().then(() => {
          child.emit("error", new Error("spawn ENOENT"));
          child.emit("close", null, null);
        });
        return child;
      }) as typeof spawn
    });
    try {
      expect(await manager.start("api")).toMatchObject({ state: "restarting", pid: null, lastError: "spawn ENOENT" });
      await vi.advanceTimersByTimeAsync(1);
      expect(children).toHaveLength(2);
      expect(manager.getStatus()[0]).toMatchObject({ state: "failed", pid: null, restartCount: 1, lastError: "Restart limit reached after 1 attempt." });
    } finally {
      await manager.stopAll();
      vi.useRealTimers();
    }
  });

  it("marks a successful exit before startup completion as a startup failure", async () => {
    const child = fakeChild(10201, { autoSpawn: false });
    const onFatalExit = vi.fn();
    const { manager } = managerFor([processConfig({ killOnExit: true })], {
      spawnProcess: (() => child) as typeof spawn,
      onFatalExit
    });
    const starting = manager.start("api");
    child.emit("close", 0, null);
    expect(await starting).toMatchObject({ state: "failed", pid: null, lastExitCode: 0 });
    expect(onFatalExit).toHaveBeenCalledTimes(1);
    expect(onFatalExit.mock.calls[0]?.[1]).toMatchObject({ state: "failed", pid: null });
    await manager.stopAll();
  });

  it("bounds automatic retries when a dependency is unavailable without spawning a dependent", async () => {
    vi.useFakeTimers();
    const spawnProcess = vi.fn(() => fakeChild(10202));
    const { manager } = managerFor([
      processConfig({ name: "db" }),
      processConfig({ name: "web", dependsOn: ["db"], restart: "always", restartBackoffMs: 1, restartMaxAttempts: 1 })
    ], { spawnProcess: spawnProcess as unknown as typeof spawn });
    try {
      expect(await manager.start("web")).toMatchObject({ state: "restarting", pid: null });
      await vi.advanceTimersByTimeAsync(1);
      expect(manager.getStatus().find((status) => status.name === "web")).toMatchObject({ state: "failed", restartCount: 1 });
      expect(spawnProcess).not.toHaveBeenCalled();
    } finally {
      await manager.stopAll();
      vi.useRealTimers();
    }
  });

  it("does not treat a prerequisite with cleanup in progress as ready", async () => {
    const children: ChildProcess[] = [];
    const killing = deferred();
    const killed = deferred();
    const { manager } = managerFor([
      processConfig({ name: "db" }),
      processConfig({ name: "web", dependsOn: ["db"] })
    ], {
      spawnProcess: (() => {
        const child = fakeChild(10225 + children.length);
        children.push(child);
        return child;
      }) as typeof spawn,
      killProcessTree: async () => {
        killing.resolve();
        await killed.promise;
        children[0]?.emit("close", null, "SIGTERM");
      }
    });
    try {
      await manager.start("db");
      const stopping = manager.stop("db");
      await killing.promise;
      expect(await manager.start("web")).toMatchObject({ state: "failed", pid: null, lastError: expect.stringContaining('Dependency "db" is not ready') });
      expect(children).toHaveLength(1);
      killed.resolve();
      await stopping;
    } finally {
      killed.resolve();
      await manager.stopAll();
    }
  });

  it("does not reset automatic retry limits when a start is rejected for an active process", async () => {
    vi.useFakeTimers();
    const children: ChildProcess[] = [];
    const { manager } = managerFor([processConfig({ restart: "always", restartBackoffMs: 1, restartMaxAttempts: 1 })], {
      spawnProcess: (() => {
        const child = fakeChild(10250 + children.length);
        children.push(child);
        return child;
      }) as typeof spawn
    });
    try {
      await manager.start("api");
      children[0]?.emit("close", 1, null);
      await vi.advanceTimersByTimeAsync(1);
      await expect(manager.start("api")).rejects.toThrow("already has an active child");
      children[1]?.emit("close", 1, null);
      await vi.advanceTimersByTimeAsync(1);
      expect(children).toHaveLength(2);
      expect(manager.getStatus()[0]).toMatchObject({ state: "failed", restartCount: 1, lastError: "Restart limit reached after 1 attempt." });
    } finally {
      children.at(-1)?.emit("close", 1, null);
      await manager.stopAll();
      vi.useRealTimers();
    }
  });

  it("does not start a replacement when tree killing errors even if output closes", async () => {
    const child = fakeChild(10300);
    const spawnProcess = vi.fn(() => child);
    const { manager } = managerFor([processConfig()], {
      spawnProcess: spawnProcess as unknown as typeof spawn,
      killProcessTree: async () => {
        child.emit("close", null, "SIGTERM");
        throw new Error("tree cleanup failed");
      }
    });
    try {
      await manager.start("api");
      await expect(manager.restart("api")).rejects.toThrow("did not stop cleanly");
      expect(manager.getStatus()[0]).toMatchObject({ state: "failed", lastError: expect.stringContaining("tree cleanup failed") });
      expect(spawnProcess).toHaveBeenCalledTimes(1);
    } finally {
      await manager.stopAll();
    }
  });

  it("removes the temporary close listener when a stop wait times out", async () => {
    vi.useFakeTimers();
    try {
      const child = fakeChild(10301);
      const pending = waitForClose(child, 10);
      expect(child.listenerCount("close")).toBe(1);
      await vi.advanceTimersByTimeAsync(10);
      expect(await pending).toBe(false);
      expect(child.listenerCount("close")).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a new start once shutdown has begun", async () => {
    const { manager } = managerFor([processConfig()]);
    await manager.stopAll();
    await expect(manager.start("api")).rejects.toThrow("shutting down");
  });
});
