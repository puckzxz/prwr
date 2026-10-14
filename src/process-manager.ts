import { spawn } from "node:child_process";
import type { LoadedConfig, ManagedProcess, ProcessStatus } from "./types.js";
import type { PrefixedLogger } from "./logger.js";
import { killTree } from "./kill-tree.js";
import { launchProcess } from "./process-launch.js";
import { stopProcessTree } from "./process-stop.js";
import { orderedProcesses } from "./process-graph.js";
import { clearRestartTimer, restartDelayMs, shouldResetRestartAttempts } from "./restart-policy.js";
import { errorMessage, hasExited, writeToStdin } from "./process-io.js";

export interface ProcessManagerOptions {
  logger: PrefixedLogger;
  spawnProcess?: typeof spawn;
  killProcessTree?: (pid: number) => Promise<void>;
  onFatalExit?: (name: string, status: ProcessStatus) => void;
  stopTimeoutMs?: number;
  now?: () => number;
}

const DEFAULT_STOP_TIMEOUT_MS = 7000;
export const MAX_STDIN_PAYLOAD_BYTES = 16 * 1024;

export class ProcessManager {
  private readonly processes = new Map<string, ManagedProcess>();
  private readonly logger: PrefixedLogger;
  private readonly spawnProcess: typeof spawn;
  private readonly killProcessTree: (pid: number) => Promise<void>;
  private readonly onFatalExit?: (name: string, status: ProcessStatus) => void;
  private readonly stopTimeoutMs: number;
  private readonly now: () => number;
  private readonly stopPromises = new Map<string, Promise<boolean>>();
  private readonly startPromises = new Map<string, Promise<ProcessStatus>>();
  private readonly restartPromises = new Map<string, { version: number; promise: Promise<ProcessStatus> }>();
  private shuttingDown = false;

  constructor(config: LoadedConfig, options: ProcessManagerOptions) {
    this.logger = options.logger;
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.killProcessTree = options.killProcessTree ?? ((pid) => killTree(pid));
    this.onFatalExit = options.onFatalExit;
    this.stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
    this.now = options.now ?? (() => Date.now());

    for (const processConfig of orderedProcesses(config.processes)) {
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
        restartTimer: null,
        restartAttempts: 0,
        lastStartedAt: null,
        startController: null,
        stopVersion: 0,
        treeCleanup: null
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
    const state = this.getProcessOrThrow(name);
    if (this.shuttingDown) throw new Error("Cannot start processes while prwr is shutting down.");
    const version = state.stopVersion;
    const stopping = this.stopPromises.get(name);
    if (stopping && !(await stopping)) throw new Error(`Process "${name}" did not stop cleanly.`);
    if (state.stopRequested) await this.startPromises.get(name);
    if (state.stopVersion !== version || this.shuttingDown) return this.toStatus(state);
    const pending = this.startPromises.get(name);
    if (pending) return pending;
    return this.startProcess(state, true);
  }

  private async startProcess(state: ManagedProcess, resetAttempts = false): Promise<ProcessStatus> {
    const pending = this.startPromises.get(state.name);
    if (pending) return pending;
    if (this.shuttingDown) throw new Error("Cannot start processes while prwr is shutting down.");
    if (state.treeCleanup) {
      throw new Error(`Process "${state.name}" has unresolved tree cleanup for pid=${state.treeCleanup.pid}. Stop it successfully before starting again.`);
    }
    if (state.child || state.pid) throw new Error(`Process "${state.name}" already has an active child process.`);
    if (resetAttempts) state.restartAttempts = 0;
    const promise = this.performStart(state).finally(() => {
      if (this.startPromises.get(state.name) === promise) this.startPromises.delete(state.name);
    });
    this.startPromises.set(state.name, promise);
    return promise;
  }

  private async performStart(state: ManagedProcess): Promise<ProcessStatus> {
    clearRestartTimer(state);
    state.stopRequested = false;
    state.state = "starting";
    state.lastError = null;
    const controller = new AbortController();
    const version = state.stopVersion;
    state.startController = controller;
    try {
      await launchProcess(state, {
        controller,
        logger: this.logger,
        spawnProcess: this.spawnProcess,
        now: this.now,
        assertDependenciesReady: () => this.assertDependenciesReady(state),
        onExit: (child, code, signal) => {
          if (state.child !== child) return;
          state.lastExitCode = code;
          state.lastSignal = signal;
          if (state.state === "running") state.state = "stopped";
        },
        onClose: (child, code, signal) => {
          if (state.child === child) this.handleClose(state, code, signal);
        }
      });
    } catch (error) {
      if (!state.stopRequested && state.stopVersion === version && !this.shuttingDown) {
        await this.handleStartFailure(state, version, error);
      }
    } finally {
      if (state.startController === controller) state.startController = null;
    }
    await this.stopPromises.get(state.name);
    return this.toStatus(state);
  }

  private assertDependenciesReady(state: ManagedProcess): void {
    for (const name of state.config.dependsOn) {
      const dependency = this.getProcessOrThrow(name);
      if (dependency.state !== "running" || dependency.stopRequested || !dependency.child || !dependency.pid || hasExited(dependency.child)) {
        throw new Error(`Dependency "${name}" is not ready. Start it before "${state.name}".`);
      }
    }
  }

  private async handleStartFailure(state: ManagedProcess, version: number, error: unknown): Promise<void> {
    const attempts = state.restartAttempts;
    const stopped = (!state.child && !state.treeCleanup) || await this.stopProcess(state);
    if (!stopped || state.stopVersion !== version || this.shuttingDown) return;
    state.restartAttempts = attempts;
    state.lastStartedAt = null;
    state.stopRequested = false;
    state.state = "failed";
    state.lastError = errorMessage(error);
    this.logger.lifecycle(state.name, `failed to start: ${state.lastError}`, "stderr");
    if (state.config.killOnExit) {
      this.onFatalExit?.(state.name, this.toStatus(state));
    } else if (state.config.restart !== "manual") {
      this.scheduleRestart(state);
    }
  }

  async stop(name: string): Promise<ProcessStatus> {
    const processState = this.getProcessOrThrow(name);
    processState.stopVersion += 1;
    await this.stopProcess(processState);
    await this.startPromises.get(name);
    return this.toStatus(processState);
  }

  async restart(name: string): Promise<ProcessStatus> {
    const processState = this.getProcessOrThrow(name);
    if (this.shuttingDown) {
      throw new Error("Cannot restart processes while prwr is shutting down.");
    }
    const pending = this.restartPromises.get(name);
    if (pending?.version === processState.stopVersion) return pending.promise;
    processState.stopVersion += 1;
    const version = processState.stopVersion;
    const promise = this.performRestart(processState, version).finally(() => {
      if (this.restartPromises.get(name)?.promise === promise) this.restartPromises.delete(name);
    });
    this.restartPromises.set(name, { version, promise });
    return promise;
  }

  private async performRestart(processState: ManagedProcess, version: number): Promise<ProcessStatus> {
    this.logger.lifecycle(processState.name, "restarting...");
    processState.state = "restarting";
    processState.restartCount += 1;
    processState.restartAttempts = 0;
    const stopped = await this.stopProcess(processState);
    await this.startPromises.get(processState.name);
    if (!stopped) {
      throw new Error(`Process "${processState.name}" did not stop cleanly; not restarting.`);
    }
    if (processState.stopVersion !== version || this.shuttingDown) return this.toStatus(processState);
    return this.start(processState.name);
  }

  async send(name: string, text: string): Promise<{ message: string }> {
    if (Buffer.byteLength(text, "utf8") > MAX_STDIN_PAYLOAD_BYTES) {
      throw new Error(`Input is too large; maximum is ${MAX_STDIN_PAYLOAD_BYTES} bytes.`);
    }

    const processState = this.getProcessOrThrow(name);
    if (!processState.config.stdin) {
      throw new Error(`Process "${name}" does not have stdin enabled.`);
    }

    if (!processState.child || processState.state !== "running") {
      throw new Error(`Process "${name}" is not running.`);
    }

    const stdin = processState.child.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) {
      throw new Error(`Process "${name}" stdin is not writable.`);
    }

    await writeToStdin(stdin, `${text}\n`);
    return { message: `sent input to ${name}` };
  }

  async stopAll(): Promise<boolean> {
    this.shuttingDown = true;
    const results = await Promise.all(
      [...this.processes.values()].map((processState) => {
        processState.stopVersion += 1;
        return this.stopProcess(processState);
      })
    );
    await Promise.all([...this.startPromises.values()]);
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

    const promise = stopProcessTree(processState, {
      logger: this.logger,
      killProcessTree: this.killProcessTree,
      timeoutMs: this.stopTimeoutMs
    }).finally(() => {
      this.stopPromises.delete(processState.name);
    });
    this.stopPromises.set(processState.name, promise);
    return promise;
  }

  private handleClose(
    processState: ManagedProcess,
    exitCode: number | null,
    signal: NodeJS.Signals | null
  ): void {
    const startupIncomplete = processState.state === "starting";
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
    if (startupIncomplete && !processState.stopRequested && !this.shuttingDown) return;
    const shouldTriggerFatal = processState.config.killOnExit && !processState.stopRequested;
    const shouldRestart =
      !this.shuttingDown && !processState.stopRequested && this.shouldRestart(processState, exitCode, signal);

    if (shouldTriggerFatal) {
      processState.state = "stopped";
      this.onFatalExit?.(processState.name, this.toStatus(processState));
      return;
    }

    if (shouldRestart) {
      this.scheduleRestart(processState);
      return;
    }

    processState.state = processState.lastError ? "failed" : "stopped";
    processState.restartAttempts = 0;
    processState.lastStartedAt = null;
  }

  private scheduleRestart(processState: ManagedProcess): void {
    if (shouldResetRestartAttempts(processState, this.now())) {
      processState.restartAttempts = 0;
    }

    const nextAttempt = processState.restartAttempts + 1;
    if (
      processState.config.restartMaxAttempts > 0 &&
      nextAttempt > processState.config.restartMaxAttempts
    ) {
      processState.state = "failed";
      processState.lastStartedAt = null;
      processState.lastError = `Restart limit reached after ${processState.restartAttempts} attempt${
        processState.restartAttempts === 1 ? "" : "s"
      }.`;
      this.logger.lifecycle(processState.name, processState.lastError, "stderr");
      return;
    }

    const delayMs = restartDelayMs(processState.config, nextAttempt);
    processState.state = "restarting";
    processState.restartAttempts = nextAttempt;
    processState.restartCount += 1;
    processState.lastStartedAt = null;
    this.logger.lifecycle(processState.name, `restarting in ${delayMs}ms...`);
    processState.restartTimer = setTimeout(() => {
      processState.restartTimer = null;
      void this.startProcess(processState).catch((error) => {
        processState.state = "failed";
        processState.lastError = errorMessage(error);
        this.logger.lifecycle(processState.name, processState.lastError ?? "restart failed", "stderr");
      });
    }, delayMs);
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
