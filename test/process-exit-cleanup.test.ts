import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import { describe, expect, it, vi } from "vitest";
import { fakeChild, managerFor, processConfig } from "./helpers/process-manager.js";
import { close, listen, trackConnections } from "./helpers/readiness.js";

describe("process exit and tree cleanup boundaries", () => {
  it.each([true, false])("prevents dependent startup after the prerequisite exits (exit event: %s)", async (emitExit) => {
    const children: ChildProcess[] = [];
    const { manager } = managerFor([
      processConfig({ name: "db" }),
      processConfig({ name: "web", dependsOn: ["db"] })
    ], {
      spawnProcess: (() => {
        const child = fakeChild(11000 + children.length);
        children.push(child);
        return child;
      }) as typeof spawn,
      killProcessTree: async (pid) => { children.find((child) => child.pid === pid)?.emit("close", null, "SIGTERM"); }
    });
    try {
      await manager.start("db");
      Object.assign(children[0]!, { exitCode: 0, signalCode: null });
      if (emitExit) children[0]?.emit("exit", 0, null);
      expect(await manager.start("web")).toMatchObject({ state: "failed", pid: null, lastError: expect.stringContaining('Dependency "db" is not ready') });
      expect(children).toHaveLength(1);
      expect(manager.getStatus().find((status) => status.name === "db")?.pid).toBe(11000);
    } finally {
      await manager.stopAll();
    }
  });

  it.each([true, false])("cannot become ready after its own exit even when HTTP returns 200 (exit event: %s)", async (emitExit) => {
    let child!: ChildProcess;
    const server = http.createServer((_, response) => {
      Object.assign(child, { exitCode: 0, signalCode: null });
      if (emitExit) child.emit("exit", 0, null);
      response.writeHead(200).end();
    });
    const sockets = trackConnections(server);
    const port = await listen(server);
    const kills: number[] = [];
    const { manager, stdout } = managerFor([processConfig({
      readyWhen: { type: "http", url: `http://127.0.0.1:${port}`, timeoutMs: 1000, intervalMs: 10 }
    })], {
      spawnProcess: (() => { child = fakeChild(11100); return child; }) as typeof spawn,
      killProcessTree: async (pid) => {
        kills.push(pid);
        child.stdout?.emit("data", Buffer.from("last partial"));
        child.emit("close", 0, null);
      }
    });
    try {
      expect(await manager.start("api")).toMatchObject({ state: "failed", pid: null, lastExitCode: 0, lastError: expect.stringContaining("Process exited before startup completed") });
      expect(kills).toEqual([11100]);
      expect(stdout.value).toContain("api | last partial\n");
      expect(stdout.value).not.toContain("api | ready\n");
    } finally {
      await manager.stopAll();
      await close(server, sockets);
    }
  });

  it("retries unresolved tree cleanup after direct output close instead of reporting successful shutdown", async () => {
    const child = fakeChild(11200);
    const kills: number[] = [];
    const { manager } = managerFor([processConfig()], {
      spawnProcess: (() => child) as typeof spawn,
      killProcessTree: async (pid) => {
        kills.push(pid);
        if (kills.length === 1) child.emit("close", null, "SIGTERM");
        if (kills.length < 3) throw new Error("grandchild tree cleanup failed");
      }
    });
    try {
      await manager.start("api");
      expect(await manager.stopAll()).toBe(false);
      expect(manager.getStatus()[0]).toMatchObject({ state: "failed", pid: null, lastError: "Tree cleanup is incomplete for pid=11200: grandchild tree cleanup failed" });
      expect(await manager.stopAll()).toBe(false);
      expect(kills).toEqual([11200, 11200]);
      expect(await manager.stopAll()).toBe(true);
      expect(kills).toEqual([11200, 11200, 11200]);
      expect(manager.getStatus()[0]).toMatchObject({ state: "stopped", pid: null });
      expect(await manager.stopAll()).toBe(true);
      expect(kills).toHaveLength(3);
    } finally {
      await manager.stopAll();
    }
  });

  it("blocks starts after failed restart cleanup until a subsequent stop confirms the whole tree is gone", async () => {
    const children: ChildProcess[] = [];
    const kills: number[] = [];
    const { manager } = managerFor([processConfig()], {
      spawnProcess: (() => {
        const child = fakeChild(11300 + children.length);
        children.push(child);
        return child;
      }) as typeof spawn,
      killProcessTree: async (pid) => {
        kills.push(pid);
        if (kills.length === 1 || pid === 11301) children.find((child) => child.pid === pid)?.emit("close", null, "SIGTERM");
        if (kills.length < 3) throw new Error("unresolved grandchildren");
      }
    });
    try {
      await manager.start("api");
      await expect(manager.restart("api")).rejects.toThrow("did not stop cleanly");
      await expect(manager.start("api")).rejects.toThrow("unresolved tree cleanup for pid=11300");
      expect(await manager.stop("api")).toMatchObject({ state: "failed", pid: null });
      await expect(manager.start("api")).rejects.toThrow("unresolved tree cleanup for pid=11300");
      expect(children).toHaveLength(1);
      expect(await manager.stop("api")).toMatchObject({ state: "stopped", pid: null });
      expect(kills).toEqual([11300, 11300, 11300]);
      expect(await manager.start("api")).toMatchObject({ state: "running", pid: 11301 });
      expect(children).toHaveLength(2);
    } finally {
      await manager.stopAll();
    }
  });

  it("does not re-kill a confirmed-clean tree when retrying a timed-out output drain", async () => {
    vi.useFakeTimers();
    const child = fakeChild(11400);
    const killProcessTree = vi.fn(async () => {
      Object.assign(child, { exitCode: 0 });
      child.emit("exit", 0, null);
    });
    const { manager } = managerFor([processConfig()], {
      spawnProcess: (() => child) as typeof spawn,
      killProcessTree,
      stopTimeoutMs: 10
    });
    try {
      await manager.start("api");
      const stopping = manager.stop("api");
      await vi.advanceTimersByTimeAsync(10);
      expect(await stopping).toMatchObject({ state: "failed", pid: 11400, lastError: expect.stringContaining("Timed out waiting") });
      child.emit("close", 0, null);
      expect(await manager.stop("api")).toMatchObject({ state: "stopped", pid: null });
      expect(killProcessTree).toHaveBeenCalledTimes(1);
    } finally {
      child.emit("close", 0, null);
      await manager.stopAll();
      vi.useRealTimers();
    }
  });
});
