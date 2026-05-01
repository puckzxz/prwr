import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import type { LoadedConfig, ManagedProcess, ProcessStatus } from "./types.js";
import type { PrefixedLogger } from "./logger.js";
import { killTree } from "./kill-tree.js";

export interface ProcessManagerOptions {
  logger: PrefixedLogger;
  spawnProcess?: typeof spawn;
  killProcessTree?: (pid: number) => Promise<void>;
  onFatalExit?: (name: string, status: ProcessStatus) => void;
  stopTimeoutMs?: number;
}

const DEFAULT_STOP_TIMEOUT_MS = 7000;

export class ProcessManager {
  private readonly processes = new Map<string, ManagedProcess>();
  private readonly logger: PrefixedLogger;
  private readonly spawnProcess: typeof spawn;
  private readonly killProcessTree: (pid: number) => Promise<void>;
  private readonly onFatalExit?: (name: string, status: ProcessStatus) => void;
  private readonly stopTimeoutMs: number;
  private readonly stopPromises = new Map<string, Promise<boolean>>();
  private shuttingDown = false;

  constructor(config: LoadedConfig, options: ProcessManagerOptions) {
    this.logger = options.logger;
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.killProcessTree = options.killProcessTree ?? ((pid) => killTree(pid));
    this.onFatalExit = options.onFatalExit;
    this.stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;

    for (const processConfig of config.processes) {
      this.processes.set(processConfig.name, {
        name: processConfig.name,
        config: processConfig,
        command: processConfig.command,
        cwd: processConfig.cwd,
        state: "stopped",
        pid: null,
        child: null,
        lastExitCode: null,
        lastSignal: null,
        restartCount: 0,
        lastError: null,
        stopRequested: false,
        restartTimer: null
      });
    }
  }

  async startAll(): Promise<void> {
    for (const name of this.processes.keys()) {
      if (this.shuttingDown) {
        return;
      }

      await this.start(name);
    }
  }

  async start(name: string): Promise<ProcessStatus> {
    const processState = this.getProcessOrThrow(name);

    if (this.shuttingDown) {
      throw new Error("Cannot start processes while prwr is shutting down.");
    }

    if (processState.child || processState.pid) {
      throw new Error(`Process "${name}" already has an active child process.`);
    }

    if (processState.state === "running") {
      throw new Error(`Process "${name}" is already running.`);
    }

    clearRestartTimer(processState);
    processState.stopRequested = false;
    processState.state = "running";
    processState.lastError = null;

    if (processState.config.startupDelayMs > 0) {
      await delay(processState.config.startupDelayMs);
      if (this.shuttingDown || processState.stopRequested) {
        processState.child = null;
        processState.pid = null;
        processState.state = "stopped";
        return this.toStatus(processState);
      }
    }

    const options: SpawnOptions = {
      shell: true,
      cwd: processState.config.cwd,
      env: {
        ...process.env,
        FORCE_COLOR: process.env.FORCE_COLOR ?? "1",
        ...processState.config.env
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true
    };

    let child: ChildProcess;
    try {
      child = this.spawnProcess(processState.config.command, options);
    } catch (error) {
      this.markSpawnFailure(processState, error);
      return this.toStatus(processState);
    }

    processState.child = child;
    processState.pid = child.pid ?? null;

    if (child.stdout) {
      child.stdout.on("data", (chunk: Buffer) => {
        this.logger.write(name, "stdout", chunk);
      });
    }

    if (child.stderr) {
      child.stderr.on("data", (chunk: Buffer) => {
        this.logger.write(name, "stderr", chunk);
      });
    }

    child.once("error", (error) => {
      if (processState.child !== child) {
        return;
      }

      this.markSpawnFailure(processState, error);
    });

    child.once("exit", (exitCode, signal) => {
      if (processState.child !== child) {
        return;
      }

      this.handleExit(processState, exitCode, signal);
    });

    this.logger.lifecycle(name, `started pid=${processState.pid ?? "unknown"}`);
    return this.toStatus(processState);
  }

  async stop(name: string): Promise<ProcessStatus> {
    const processState = this.getProcessOrThrow(name);
    await this.stopProcess(processState);
    return this.toStatus(processState);
  }

  async restart(name: string): Promise<ProcessStatus> {
    const processState = this.getProcessOrThrow(name);
    if (this.shuttingDown) {
      throw new Error("Cannot restart processes while prwr is shutting down.");
    }

    this.logger.lifecycle(name, "restarting...");
    processState.state = "restarting";
    processState.restartCount += 1;
    const stopped = await this.stopProcess(processState);
    if (!stopped) {
      throw new Error(`Process "${name}" did not stop cleanly; not restarting.`);
    }

    return this.start(name);
  }

  async stopAll(): Promise<boolean> {
    this.shuttingDown = true;
    const results = await Promise.all(
      [...this.processes.values()].map((processState) => this.stopProcess(processState))
    );
    return results.every(Boolean);
  }

  getStatus(): ProcessStatus[] {
    return [...this.processes.values()].map((processState) => this.toStatus(processState));
  }

  availableNames(): string[] {
    return [...this.processes.keys()];
  }

  private stopProcess(processState: ManagedProcess): Promise<boolean> {
    const existing = this.stopPromises.get(processState.name);
    if (existing) {
      return existing;
    }

    const promise = this.performStop(processState).finally(() => {
      this.stopPromises.delete(processState.name);
    });
    this.stopPromises.set(processState.name, promise);
    return promise;
  }

  private async performStop(processState: ManagedProcess): Promise<boolean> {
    clearRestartTimer(processState);
    processState.stopRequested = true;

    if (!processState.child || !processState.pid) {
      processState.child = null;
      processState.pid = null;
      processState.state = "stopped";
      return true;
    }

    const child = processState.child;
    const pid = processState.pid;
    const exitPromise = waitForExit(child, this.stopTimeoutMs);
    let killError: string | null = null;

    try {
      await this.killProcessTree(pid);
    } catch (error) {
      killError = errorMessage(error);
      this.logger.lifecycle(processState.name, `failed to stop pid=${pid}: ${killError}`, "stderr");
    }

    const exited = await exitPromise;

    if (processState.child !== child) {
      return true;
    }

    if (exited) {
      processState.child = null;
      processState.pid = null;
      processState.state = "stopped";
      return true;
    }

    processState.state = "failed";
    processState.lastError =
      killError ?? `Timed out waiting for process pid=${pid} to exit after stop request.`;
    this.logger.lifecycle(processState.name, processState.lastError, "stderr");
    return false;
  }

  private handleExit(
    processState: ManagedProcess,
    exitCode: number | null,
    signal: NodeJS.Signals | null
  ): void {
    this.logger.flush(processState.name);
    processState.child = null;
    processState.pid = null;
    processState.lastExitCode = exitCode;
    processState.lastSignal = signal;

    const stoppedMessage =
      signal === null
        ? `stopped exitCode=${exitCode ?? "null"}`
        : `stopped signal=${signal} exitCode=${exitCode ?? "null"}`;
    this.logger.lifecycle(processState.name, stoppedMessage);

    const status = this.toStatus(processState);
    const shouldTriggerFatal = processState.config.killOnExit && !processState.stopRequested;
    const shouldRestart =
      !this.shuttingDown && !processState.stopRequested && this.shouldRestart(processState, exitCode, signal);

    if (shouldTriggerFatal) {
      processState.state = "stopped";
      this.onFatalExit?.(processState.name, status);
      return;
    }

    if (shouldRestart) {
      processState.state = "restarting";
      processState.restartCount += 1;
      this.logger.lifecycle(processState.name, "restarting...");
      processState.restartTimer = setTimeout(() => {
        processState.restartTimer = null;
        void this.start(processState.name).catch((error) => {
          processState.state = "failed";
          processState.lastError = errorMessage(error);
          this.logger.lifecycle(processState.name, processState.lastError ?? "restart failed", "stderr");
        });
      }, Math.max(100, processState.config.startupDelayMs));
      return;
    }

    processState.state = processState.lastError ? "failed" : "stopped";
  }

  private shouldRestart(
    processState: ManagedProcess,
    exitCode: number | null,
    signal: NodeJS.Signals | null
  ): boolean {
    if (processState.config.restart === "always") {
      return true;
    }

    if (processState.config.restart === "on-failure") {
      return exitCode !== 0 || signal !== null;
    }

    return false;
  }

  private markSpawnFailure(processState: ManagedProcess, error: unknown): void {
    this.logger.flush(processState.name);
    processState.child = null;
    processState.pid = null;
    processState.state = "failed";
    processState.lastExitCode = null;
    processState.lastSignal = null;
    processState.lastError = errorMessage(error);
    this.logger.lifecycle(processState.name, `failed to start: ${processState.lastError}`, "stderr");
  }

  private getProcessOrThrow(name: string): ManagedProcess {
    const processState = this.processes.get(name);
    if (!processState) {
      throw new Error(`Unknown process "${name}". Available processes: ${this.availableNames().join(", ")}`);
    }

    return processState;
  }

  private toStatus(processState: ManagedProcess): ProcessStatus {
    return {
      name: processState.name,
      state: processState.state,
      pid: processState.pid,
      command: processState.command,
      cwd: processState.cwd,
      lastExitCode: processState.lastExitCode,
      lastSignal: processState.lastSignal,
      restartCount: processState.restartCount,
      lastError: processState.lastError
    };
  }
}

function clearRestartTimer(processState: ManagedProcess): void {
  if (processState.restartTimer) {
    clearTimeout(processState.restartTimer);
    processState.restartTimer = null;
  }
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(false);
      }
    }, timeoutMs);

    child.once("exit", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        resolve(true);
      }
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
