import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { PrefixedLogger, type WritableStreamLike } from "../../src/logger.js";
import { ProcessManager, type ProcessManagerOptions } from "../../src/process-manager.js";
import type { LoadedConfig, ProcessConfig } from "../../src/types.js";

export class MemoryStream implements WritableStreamLike {
  value = "";

  write(chunk: string): void {
    this.value += chunk;
  }
}

export function nodeCommand(script: string): string {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
}

export function processConfig(overrides: Partial<ProcessConfig> = {}): ProcessConfig {
  return {
    name: "api",
    command: nodeCommand("setTimeout(() => undefined, 1000)"),
    cwd: mkdtempSync(path.join(tmpdir(), "prwr-proc-")),
    env: {},
    dependsOn: [],
    readyWhen: null,
    restart: "manual",
    killOnExit: false,
    stdin: false,
    startupDelayMs: 0,
    restartBackoffMs: 0,
    restartBackoffMaxMs: 0,
    restartBackoffResetMs: 0,
    restartMaxAttempts: 0,
    ...overrides
  };
}

export function managerFor(processes: ProcessConfig[], options: Partial<ProcessManagerOptions> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "prwr-manager-"));
  const config: LoadedConfig = {
    configPath: path.join(dir, ".prwr.yml"),
    configDir: dir,
    projectRoot: dir,
    sourceType: "yaml",
    processes
  };
  const stdout = new MemoryStream();
  const stderr = new MemoryStream();
  const logger = new PrefixedLogger({
    names: processes.map((process) => process.name),
    stdout,
    stderr,
    colorMode: "never"
  });
  const manager = new ProcessManager(config, { logger, ...options });
  return { manager, stdout, stderr, logger };
}

export function fakeChild(pid: number, options: { stdin?: boolean; autoSpawn?: boolean } = {}): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, {
    pid,
    exitCode: null,
    signalCode: null,
    stdin: options.stdin ? new PassThrough() : null,
    stdout: new PassThrough(),
    stderr: new PassThrough()
  });
  if (options.autoSpawn !== false) {
    void Promise.resolve().then(() => child.emit("spawn"));
  }
  return child;
}

export async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for condition.");
    }
    await delay(25);
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
