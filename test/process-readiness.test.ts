import { spawn, type ChildProcess } from "node:child_process";
import { writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { isPidAlive } from "../src/kill-tree.js";
import { fakeChild, managerFor, nodeCommand, processConfig, waitFor } from "./helpers/process-manager.js";
import { close, listen, observeProcessSpawns, trackConnections, unusedPort, waitForGrandchildOutput, waitForRealTime } from "./helpers/readiness.js";

function readyTcp(port: number, timeoutMs = 3000) {
  return { type: "tcp" as const, host: "127.0.0.1", port, timeoutMs, intervalMs: 10 };
}

function serviceCommand(port: number): string {
  return nodeCommand(
    "const net = require('node:net'); const fs = require('node:fs'); console.log('booting'); " +
    `function ready() { if (fs.existsSync('allow-ready')) net.createServer(socket => socket.end()).listen(${port}, '127.0.0.1'); else setTimeout(ready, 10); } ready();`
  );
}

function treeCommand(): string {
  return nodeCommand(
    "const { spawn } = require('node:child_process'); " +
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); " +
    "console.log('grandchild=' + child.pid); process.stdout.write('final-partial'); setInterval(() => {}, 1000);"
  );
}

function grandchildren(output: string): number[] {
  return [...output.matchAll(/grandchild=(\d+)/g)].map((match) => Number(match[1]));
}

describe("process readiness and dependencies", () => {
  it("reports starting until the real child accepts TCP connections", async () => {
    const port = await unusedPort();
    const config = processConfig({ command: serviceCommand(port), readyWhen: readyTcp(port) });
    const { manager, stdout } = managerFor([config]);
    try {
      const starting = manager.start("api");
      await waitFor(() => stdout.value.includes("booting"));
      expect(manager.getStatus()[0]?.state).toBe("starting");
      await writeFile(path.join(config.cwd, "allow-ready"), "ready");
      expect(await starting).toMatchObject({ state: "running", lastError: null });
      expect(stdout.value).toContain("api | ready\n");
    } finally {
      await manager.stopAll();
    }
  });

  it("waits for a real child's HTTP health endpoint and reacquires readiness on restart", async () => {
    const port = await unusedPort();
    const { manager, stdout } = managerFor([processConfig({
      command: nodeCommand(`require('node:http').createServer((_, response) => response.writeHead(204).end()).listen(${port}, '127.0.0.1');`),
      readyWhen: { type: "http", url: `http://127.0.0.1:${port}/health`, timeoutMs: 3000, intervalMs: 10 }
    })]);
    try {
      const original = await manager.start("api");
      expect(original.state).toBe("running");
      const replacement = await manager.restart("api");
      expect(replacement.state).toBe("running");
      expect(replacement.pid).not.toBe(original.pid);
      expect(isPidAlive(original.pid!)).toBe(false);
      expect(stdout.value.match(/api \| ready\n/g)).toHaveLength(2);
    } finally {
      await manager.stopAll();
    }
  });

  it("starts a prerequisite before its dependent even when config lists the dependent first", async () => {
    const port = await unusedPort();
    const dependency = processConfig({ name: "db", command: serviceCommand(port), readyWhen: readyTcp(port) });
    const dependent = processConfig({
      name: "web",
      dependsOn: ["db"],
      command: nodeCommand(
        `require('node:net').connect(${port}, '127.0.0.1', () => console.log('connected')); ` +
        "setInterval(() => {}, 1000);"
      )
    });
    const { manager, stdout } = managerFor([dependent, dependency]);
    try {
      const starting = manager.startAll();
      await waitFor(() => stdout.value.includes("db  | booting"));
      expect(manager.getStatus().map((status) => status.state)).toEqual(["starting", "stopped"]);
      await writeFile(path.join(dependency.cwd, "allow-ready"), "ready");
      await starting;
      await waitFor(() => stdout.value.includes("web | connected"));
      expect(manager.getStatus().map((status) => status.state)).toEqual(["running", "running"]);
      expect(stdout.value.indexOf("db  | ready\n")).toBeLessThan(stdout.value.indexOf("web | started pid="));
    } finally {
      await manager.stopAll();
    }
  });

  it("rejects a dependent start and restart until its prerequisite is ready", async () => {
    const port = await unusedPort();
    const children: ChildProcess[] = [];
    const dependency = processConfig({ name: "db", command: serviceCommand(port), readyWhen: readyTcp(port) });
    const { manager, stdout } = managerFor([
      dependency,
      processConfig({ name: "web", dependsOn: ["db"], command: nodeCommand("setInterval(() => {}, 1000)") })
    ], {
      spawnProcess: ((...args: Parameters<typeof spawn>) => {
        const child = spawn(...args);
        children.push(child);
        return child;
      }) as typeof spawn
    });
    try {
      const starting = manager.start("db");
      await waitFor(() => stdout.value.includes("booting"));
      expect(await manager.start("web")).toMatchObject({ state: "failed", pid: null, lastError: expect.stringContaining('Dependency "db" is not ready') });
      expect(await manager.restart("web")).toMatchObject({ state: "failed", pid: null });
      expect(children).toHaveLength(1);
      await writeFile(path.join(dependency.cwd, "allow-ready"), "ready");
      await starting;
      expect(await manager.start("web")).toMatchObject({ state: "running", lastError: null });
      expect(children).toHaveLength(2);
    } finally {
      await manager.stopAll();
    }
  });

  it("rechecks dependencies when a dependent finishes readiness", async () => {
    let requests = 0;
    let healthy = false;
    const server = http.createServer((_, response) => {
      requests += 1;
      response.writeHead(healthy ? 200 : 503).end();
    });
    const sockets = trackConnections(server);
    const port = await listen(server);
    const children = new Map<number, ChildProcess>();
    const killed: number[] = [];
    const { manager } = managerFor([
      processConfig({ name: "db" }),
      processConfig({ name: "web", dependsOn: ["db"], readyWhen: { type: "http", url: `http://127.0.0.1:${port}`, timeoutMs: 3000, intervalMs: 10 } })
    ], {
      spawnProcess: (() => {
        const child = fakeChild(9900 + children.size);
        children.set(child.pid!, child);
        return child;
      }) as typeof spawn,
      killProcessTree: async (pid) => {
        killed.push(pid);
        children.get(pid)?.emit("close", null, "SIGTERM");
      }
    });
    try {
      await manager.start("db");
      const starting = manager.start("web");
      await waitFor(() => requests > 0);
      await manager.stop("db");
      healthy = true;
      expect(await starting).toMatchObject({ state: "failed", pid: null, lastError: expect.stringContaining('Dependency "db" is not ready') });
      expect(killed).toEqual([9900, 9901]);
    } finally {
      await manager.stopAll();
      await close(server, sockets);
    }
  });

  it("leaves an already-running dependent running when a prerequisite stops", async () => {
    const children = new Map<number, ChildProcess>();
    const { manager } = managerFor([
      processConfig({ name: "db" }),
      processConfig({ name: "web", dependsOn: ["db"] })
    ], {
      spawnProcess: (() => {
        const child = fakeChild(9950 + children.size);
        children.set(child.pid!, child);
        return child;
      }) as typeof spawn,
      killProcessTree: async (pid) => { children.get(pid)?.emit("close", null, "SIGTERM"); }
    });
    try {
      await manager.startAll();
      await manager.stop("db");
      expect(manager.getStatus().map((status) => status.state)).toEqual(["stopped", "running"]);
    } finally {
      await manager.stopAll();
    }
  });

  it("cleans a real tree and flushes partial output when readiness times out", async () => {
    const port = await unusedPort();
    const clock = vi.spyOn(Date, "now").mockReturnValue(0);
    const { runs, spawnProcess } = observeProcessSpawns();
    const { manager, stdout } = managerFor([processConfig({ command: treeCommand(), readyWhen: readyTcp(port, 700) })], { spawnProcess });
    try {
      const starting = manager.start("api");
      const grandchild = await waitForGrandchildOutput(runs, 0);
      expect(manager.getStatus()[0]?.state).toBe("starting");
      // Advance the deadline only after the real descendant and full partial
      // output exist, so machine-dependent Node startup speed cannot race it.
      clock.mockReturnValue(700);
      expect(await starting).toMatchObject({ state: "failed", pid: null, lastError: "Readiness timed out after 700ms." });
      const pids = grandchildren(stdout.value);
      expect(pids).toEqual([grandchild]);
      expect(pids.every((pid) => !isPidAlive(pid))).toBe(true);
      expect(stdout.value).toContain("api | final-partial\n");
    } finally {
      clock.mockRestore();
      await manager.stopAll();
    }
  });

  it("bounds automatic readiness retries without treating an unready lifetime as a stable run", async () => {
    const port = await unusedPort();
    const clock = vi.spyOn(Date, "now").mockReturnValue(0);
    const { runs, spawnProcess } = observeProcessSpawns();
    const { manager, stdout } = managerFor([processConfig({
      command: treeCommand(),
      readyWhen: readyTcp(port, 700),
      restart: "on-failure",
      restartBackoffMs: 1,
      restartBackoffResetMs: 10,
      restartMaxAttempts: 1
    })], { spawnProcess });
    try {
      const starting = manager.start("api");
      const firstGrandchild = await waitForGrandchildOutput(runs, 0);
      clock.mockReturnValue(700);
      await starting;
      const secondGrandchild = await waitForGrandchildOutput(runs, 1);
      expect(isPidAlive(firstGrandchild)).toBe(false);
      expect(manager.getStatus()[0]?.state).toBe("starting");
      clock.mockReturnValue(1400);
      await waitForRealTime(() => manager.getStatus()[0]?.state === "failed");
      expect(manager.getStatus()[0]).toMatchObject({ pid: null, restartCount: 1, lastError: "Restart limit reached after 1 attempt." });
      const pids = grandchildren(stdout.value);
      expect(pids).toEqual([firstGrandchild, secondGrandchild]);
      expect(pids.every((pid) => !isPidAlive(pid))).toBe(true);
    } finally {
      clock.mockRestore();
      await manager.stopAll();
    }
  });

  it.each(["stop", "down"])("cancels pending readiness and kills real grandchildren on %s", async (action) => {
    const port = await unusedPort();
    const { manager, stdout } = managerFor([processConfig({ command: treeCommand(), readyWhen: readyTcp(port, 10000), restart: "always", restartBackoffMs: 1 })]);
    try {
      const starting = manager.start("api");
      await waitFor(() => grandchildren(stdout.value).length === 1);
      if (action === "stop") await manager.stop("api");
      else expect(await manager.stopAll()).toBe(true);
      expect(await starting).toMatchObject({ state: "stopped", pid: null, restartCount: 0 });
      expect(grandchildren(stdout.value).every((pid) => !isPidAlive(pid))).toBe(true);
    } finally {
      await manager.stopAll();
    }
  });
});
