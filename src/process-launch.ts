import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { childEnvironment } from "./env-files.js";
import { waitForReadiness } from "./readiness.js";
import { delay } from "./timing.js";
import { hasExited, waitForSpawn } from "./process-io.js";
import type { PrefixedLogger } from "./logger.js";
import type { ManagedProcess } from "./types.js";

export interface LaunchOptions {
  controller: AbortController;
  logger: PrefixedLogger;
  spawnProcess: typeof spawn;
  now: () => number;
  assertDependenciesReady: () => void;
  onExit: (child: ChildProcess, code: number | null, signal: NodeJS.Signals | null) => void;
  onClose: (child: ChildProcess, code: number | null, signal: NodeJS.Signals | null) => void;
}

export async function launchProcess(state: ManagedProcess, options: LaunchOptions): Promise<void> {
  const { controller, logger } = options;
  if (state.config.startupDelayMs > 0) await delay(state.config.startupDelayMs, controller.signal);
  controller.signal.throwIfAborted();
  options.assertDependenciesReady();
  const spawnOptions: SpawnOptions = {
    shell: true,
    cwd: state.config.cwd,
    env: childEnvironment(state.config.env),
    stdio: [state.config.stdin ? "pipe" : "ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true
  };
  const child = options.spawnProcess(state.config.command, spawnOptions);
  state.child = child;
  state.pid = child.pid ?? null;
  state.lastStartedAt = null;
  child.stdout?.on("data", (chunk: Buffer) => logger.write(state.name, "stdout", chunk));
  child.stderr?.on("data", (chunk: Buffer) => logger.write(state.name, "stderr", chunk));
  child.once("error", (error) => controller.abort(error));
  child.once("exit", (code, signal) => {
    controller.abort(new Error(`Process exited before startup completed (exitCode=${code ?? "null"}).`));
    options.onExit(child, code, signal);
  });
  // Close follows exit and the final stdout/stderr data, preserving run boundaries.
  child.once("close", (code, signal) => {
    controller.abort(new Error(`Process closed before startup completed (exitCode=${code ?? "null"}).`));
    options.onClose(child, code, signal);
  });
  await waitForSpawn(child, controller.signal);
  assertChildActive(child, controller.signal);
  logger.lifecycle(state.name, `started pid=${state.pid ?? "unknown"}`);
  if (state.config.readyWhen) {
    logger.lifecycle(state.name, "waiting for readiness...");
    await waitForReadiness(state.config.readyWhen, controller.signal);
    assertChildActive(child, controller.signal);
    options.assertDependenciesReady();
    logger.lifecycle(state.name, "ready");
  }
  assertChildActive(child, controller.signal);
  state.lastStartedAt = options.now();
  state.state = "running";
}

function assertChildActive(child: ChildProcess, signal: AbortSignal): void {
  signal.throwIfAborted();
  if (hasExited(child)) throw new Error("Process exited before startup completed.");
}
