import { performance } from "node:perf_hooks";
import { SUPERVISOR_NOT_RUNNING } from "./control-client.js";
import { isSupervisorStatus, sameSupervisorIdentity } from "./control-protocol.js";
import { sendProjectCommand } from "./supervisor.js";
import { delay, MAX_TIMER_MS } from "./timing.js";
import type { ProcessStatus, ProcessWaitOptions, PublicSupervisorState, SupervisorStatus } from "./types.js";

export const DEFAULT_WAIT_TIMEOUT_MS = 30000;
const WAIT_INTERVAL_MS = 100;

export function validateWaitTimeout(value: number): void {
  if (!Number.isInteger(value) || value <= 0 || value > MAX_TIMER_MS) {
    throw new Error(`Wait timeout must be an integer between 1 and ${MAX_TIMER_MS} milliseconds.`);
  }
}

export async function waitForProcesses(cwd: string, options: ProcessWaitOptions): Promise<SupervisorStatus> {
  validateWaitTimeout(options.timeoutMs);
  const controller = new AbortController();
  const deadline = performance.now() + options.timeoutMs;
  let supervisor: PublicSupervisorState | undefined;
  let pending: ProcessStatus[] = [];
  const timeoutError = () => new Error(`Timed out after ${options.timeoutMs}ms waiting for ${
    pending.length ? pending.map(({ name, state }) => `${name} (${state})`).join(", ") : "prwr supervisor"
  }.`);
  const timer = setTimeout(() => controller.abort(timeoutError()), options.timeoutMs);
  const onAbort = () => controller.abort(options.signal!.reason);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();

  try {
    while (true) {
      controller.signal.throwIfAborted();
      const response = await sendProjectCommand(cwd, { type: "status" }, {
        configPath: options.configPath, signal: controller.signal
      });
      controller.signal.throwIfAborted();
      if (performance.now() >= deadline) throw timeoutError();
      if (!response.ok) {
        if (response.error !== SUPERVISOR_NOT_RUNNING) throw new Error(response.error);
        if (supervisor) throw new Error("prwr supervisor stopped while waiting for processes.");
      } else {
        if (!isSupervisorStatus(response.data)) throw new Error("Supervisor returned an invalid status response.");
        const status = response.data;
        if (supervisor && !sameSupervisorIdentity(supervisor, status.supervisor)) {
          throw new Error("prwr supervisor changed while waiting for processes.");
        }
        supervisor = status.supervisor;
        const selected = selectWaitProcesses(status.processes, options.names);
        const failed = selected.find(({ state }) => state === "failed");
        if (failed) throw new Error(`Process "${failed.name}" failed: ${failed.lastError ?? "startup failed."}`);
        pending = selected.filter(({ state }) => state !== "running");
        if (!pending.length) return status;
      }
      await delay(WAIT_INTERVAL_MS, controller.signal);
    }
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

function selectWaitProcesses(processes: ProcessStatus[], names: string[]): ProcessStatus[] {
  if (!names.length) return processes;
  return names.map((name) => {
    const selected = processes.find((process) => process.name === name);
    if (!selected) throw new Error(`Unknown process "${name}". Available processes: ${processes.map(({ name }) => name).join(", ")}`);
    return selected;
  });
}
