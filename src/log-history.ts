import { StringDecoder } from "node:string_decoder";
import type { ProcessLogEntry } from "./types.js";

export const DEFAULT_LOG_TAIL = 50;
export const MAX_LOG_TAIL = 1000;
export const MAX_LOG_HISTORY_BYTES = 128 * 1024;
export const MAX_LOG_TEXT_BYTES = 8 * 1024;

interface StoredEntry {
  entry: ProcessLogEntry;
  bytes: number;
}

export class LogHistory {
  private readonly histories = new Map<string, { entries: StoredEntry[]; bytes: number }>();

  constructor(names: string[]) {
    for (const name of names) this.histories.set(name, { entries: [], bytes: 0 });
  }

  add(entry: ProcessLogEntry): void {
    const history = this.histories.get(entry.name);
    if (!history) return;
    const text = truncate(entry.text);
    const stored = { ...entry, text };
    const bytes = Buffer.byteLength(JSON.stringify(stored), "utf8") + 1;
    history.entries.push({ entry: stored, bytes });
    history.bytes += bytes;
    while (history.entries.length > MAX_LOG_TAIL || history.bytes > MAX_LOG_HISTORY_BYTES) {
      history.bytes -= history.entries.shift()!.bytes;
    }
  }

  get(name: string, tail = DEFAULT_LOG_TAIL): ProcessLogEntry[] {
    if (!isLogTail(tail)) throw new Error(`Log tail must be an integer between 0 and ${MAX_LOG_TAIL}.`);
    const history = this.histories.get(name);
    if (!history) throw new Error(`Unknown process "${name}". Available processes: ${[...this.histories.keys()].join(", ")}`);
    return tail === 0 ? [] : history.entries.slice(-tail).map(({ entry }) => ({ ...entry }));
  }
}

export function isLogTail(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_LOG_TAIL;
}

function truncate(text: string): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= MAX_LOG_TEXT_BYTES) return text;
  const suffix = "... [truncated]";
  const decoder = new StringDecoder("utf8");
  return decoder.write(bytes.subarray(0, MAX_LOG_TEXT_BYTES - Buffer.byteLength(suffix))) + suffix;
}
