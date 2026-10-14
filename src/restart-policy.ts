import type { ManagedProcess } from "./types.js";
import { MAX_TIMER_MS } from "./timing.js";

export function clearRestartTimer(processState: ManagedProcess): void {
  if (processState.restartTimer) {
    clearTimeout(processState.restartTimer);
    processState.restartTimer = null;
  }
}

export function shouldResetRestartAttempts(processState: ManagedProcess, now: number): boolean {
  if (processState.config.restartBackoffResetMs <= 0 || processState.lastStartedAt === null) {
    return false;
  }

  return now - processState.lastStartedAt >= processState.config.restartBackoffResetMs;
}

export function restartDelayMs(
  config: Pick<
    ManagedProcess["config"],
    "startupDelayMs" | "restartBackoffMs" | "restartBackoffMaxMs"
  >,
  attempt: number
): number {
  const baseDelay = config.restartBackoffMs > 0 ? config.restartBackoffMs : Math.max(100, config.startupDelayMs);
  const backoffEnabled = config.restartBackoffMs > 0 || config.restartBackoffMaxMs > 0;
  if (!backoffEnabled) {
    return baseDelay;
  }

  const exponentialDelay = Math.min(MAX_TIMER_MS, baseDelay * 2 ** Math.max(0, attempt - 1));
  return config.restartBackoffMaxMs > 0
    ? Math.min(config.restartBackoffMaxMs, exponentialDelay)
    : exponentialDelay;
}
