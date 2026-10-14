import { setTimeout as sleep } from "node:timers/promises";

export const MAX_TIMER_MS = 2147483647;

export async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  try {
    await sleep(ms, undefined, { signal });
  } catch (error) {
    signal?.throwIfAborted();
    throw error;
  }
}
