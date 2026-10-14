import type { ChildProcess } from "node:child_process";

export function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

export function writeToStdin(stdin: NonNullable<ChildProcess["stdin"]>, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stdin.write(text, (error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

export function waitForClose(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const close = () => finish(true);
    const timeout = setTimeout(() => finish(false), timeoutMs);
    function finish(closed: boolean): void {
      clearTimeout(timeout);
      child.removeListener("close", close);
      resolve(closed);
    }
    child.once("close", close);
  });
}

export function waitForSpawn(child: ChildProcess, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const spawned = () => finish();
    const aborted = () => finish(signal.reason);
    function finish(error?: unknown): void {
      child.removeListener("spawn", spawned);
      signal.removeEventListener("abort", aborted);
      if (error !== undefined) reject(error);
      else resolve();
    }
    child.once("spawn", spawned);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
