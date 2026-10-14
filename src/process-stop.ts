import type { PrefixedLogger } from "./logger.js";
import { errorMessage, waitForClose } from "./process-io.js";
import { clearRestartTimer } from "./restart-policy.js";
import type { ManagedProcess } from "./types.js";

interface StopOptions {
  logger: PrefixedLogger;
  killProcessTree: (pid: number) => Promise<void>;
  timeoutMs: number;
}

export async function stopProcessTree(state: ManagedProcess, options: StopOptions): Promise<boolean> {
  clearRestartTimer(state);
  state.stopRequested = true;
  if (!state.treeCleanup && state.pid !== null) {
    state.treeCleanup = { pid: state.pid, killed: false };
  }
  state.startController?.abort(new Error("Process start cancelled by stop request."));
  if (!state.child && !state.treeCleanup) {
    markStopped(state);
    return true;
  }
  const child = state.child;
  const cleanup = state.treeCleanup;
  const pid = cleanup?.pid ?? null;
  const closePromise = child ? waitForClose(child, options.timeoutMs) : Promise.resolve(true);
  let killError: string | null = null;
  if (cleanup && !cleanup.killed) {
    try {
      await options.killProcessTree(cleanup.pid);
      cleanup.killed = true;
    } catch (error) {
      killError = errorMessage(error);
    }
  }
  const closed = await closePromise;
  if (closed && killError === null) {
    markStopped(state);
    return true;
  }
  state.state = "failed";
  state.lastError = killError
    ? `Tree cleanup is incomplete for pid=${pid}: ${killError}`
    : `Timed out waiting for process pid=${pid ?? "unknown"} to close after stop request.`;
  options.logger.lifecycle(state.name, state.lastError, "stderr");
  return false;
}

function markStopped(state: ManagedProcess): void {
  state.child = null;
  state.pid = null;
  state.treeCleanup = null;
  state.state = "stopped";
  state.restartAttempts = 0;
  state.lastStartedAt = null;
}
