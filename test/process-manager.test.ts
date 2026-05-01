import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { isPidAlive } from "../src/kill-tree.js";
import { PrefixedLogger, type WritableStreamLike } from "../src/logger.js";
import { ProcessManager, type ProcessManagerOptions } from "../src/process-manager.js";
import type { LoadedConfig, ProcessConfig } from "../src/types.js";

class MemoryStream implements WritableStreamLike {
  value = "";

  write(chunk: string): void {
    this.value += chunk;
  }
}

function nodeCommand(script: string): string {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
}

function configFor(processes: ProcessConfig[]): LoadedConfig {
  const dir = mkdtempSync(path.join(tmpdir(), "prwr-manager-"));
  return {
    configPath: path.join(dir, ".prwr.yml"),
    configDir: dir,
    projectRoot: dir,
    sourceType: "yaml",
    processes
  };
}

function processConfig(overrides: Partial<ProcessConfig> = {}): ProcessConfig {
  const cwd = mkdtempSync(path.join(tmpdir(), "prwr-proc-"));
  return {
    name: "api",
    command: nodeCommand("setTimeout(() => undefined, 1000)"),
    cwd,
    env: {},
    restart: "manual",
    killOnExit: false,
    startupDelayMs: 0,
    ...overrides
  };
}

function managerFor(processes: ProcessConfig[], options: Partial<ProcessManagerOptions> = {}) {
  const stdout = new MemoryStream();
  const stderr = new MemoryStream();
  const logger = new PrefixedLogger({
    names: processes.map((process) => process.name),
    stdout,
    stderr,
    colorMode: "never"
  });
  const manager = new ProcessManager(configFor(processes), {
    logger,
    ...options
  });
  return { manager, stdout, stderr };
}

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

  it("waits for the old process to exit before spawning a restart replacement", async () => {
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
      }
    });

    await manager.start("api");
    await manager.restart("api");

    expect(events).toEqual(["spawn:9100", "kill:9100", "exit:9100", "spawn:9101"]);
  });

  it("shares an in-flight stop during repeated shutdown requests", async () => {
    const child = fakeChild(9200);
    let killCalls = 0;
    const { manager } = managerFor([processConfig()], {
      spawnProcess: (() => child) as typeof spawn,
      killProcessTree: async () => {
        killCalls += 1;
        await delay(20);
        child.emit("exit", null, "SIGTERM");
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

  it("flushes final partial stdout and stderr when a child exits", async () => {
    const process = processConfig({
      command: nodeCommand("process.stdout.write('out-partial'); process.stderr.write('err-partial')")
    });
    const { manager, stdout, stderr } = managerFor([process]);

    await manager.start("api");
    await waitFor(() => manager.getStatus()[0]?.state === "stopped");

    expect(stdout.value).toContain("api | out-partial\n");
    expect(stderr.value).toContain("api | err-partial\n");
  });

  it("stops child process trees so node grandchildren are not left running", async () => {
    const script =
      "const { spawn } = require('node:child_process'); " +
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); " +
      "console.log('grandchild=' + child.pid); " +
      "setInterval(() => {}, 1000);";
    const process = processConfig({ command: nodeCommand(script) });
    const { manager, stdout } = managerFor([process]);

    await manager.start("api");
    await waitFor(() => /grandchild=\d+/.test(stdout.value));
    const grandchildPid = Number(stdout.value.match(/grandchild=(\d+)/)?.[1]);

    await manager.stop("api");
    await waitFor(() => !isPidAlive(grandchildPid));

    expect(manager.getStatus()[0]?.state).toBe("stopped");
    expect(isPidAlive(grandchildPid)).toBe(false);
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
});

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const startedAt = Date.now();

  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for condition.");
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }
}

function fakeChild(pid: number): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, {
    pid,
    stdout: new PassThrough(),
    stderr: new PassThrough()
  });
  return child;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
