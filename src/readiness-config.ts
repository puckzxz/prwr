import type { ReadinessCheck } from "./types.js";
import { MAX_TIMER_MS } from "./timing.js";

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_INTERVAL_MS = 100;

export function normalizeReadiness(value: unknown, name: string): ReadinessCheck | null {
  if (value === undefined || value === null) return null;
  const context = `Invalid process "${name}": readyWhen`;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context} must be an object.`);
  }
  const raw = value as Record<string, unknown>;
  const timing = {
    timeoutMs: positiveTimer(raw.timeoutMs, DEFAULT_TIMEOUT_MS, `${context}.timeoutMs`),
    intervalMs: positiveTimer(raw.intervalMs, DEFAULT_INTERVAL_MS, `${context}.intervalMs`)
  };
  switch (raw.type) {
    case "tcp": {
      const fields = { type: true, host: true, port: true, timeoutMs: true, intervalMs: true } satisfies
        Record<keyof Extract<ReadinessCheck, { type: "tcp" }>, true>;
      knownFields(raw, fields, context);
      if (typeof raw.port !== "number" || !Number.isInteger(raw.port) || raw.port < 1 || raw.port > 65535) {
        throw new Error(`${context}.port must be an integer between 1 and 65535.`);
      }
      if (raw.host !== undefined && (typeof raw.host !== "string" || !raw.host.trim())) {
        throw new Error(`${context}.host must be a non-empty string.`);
      }
      return { type: "tcp", host: (raw.host as string | undefined)?.trim() ?? "127.0.0.1", port: raw.port, ...timing };
    }
    case "http": {
      const fields = { type: true, url: true, timeoutMs: true, intervalMs: true } satisfies
        Record<keyof Extract<ReadinessCheck, { type: "http" }>, true>;
      knownFields(raw, fields, context);
      let url: URL;
      try {
        url = new URL(typeof raw.url === "string" ? raw.url : "");
      } catch {
        throw new Error(`${context}.url must be an absolute HTTP or HTTPS URL.`);
      }
      if (!new Set(["http:", "https:"]).has(url.protocol) || url.username || url.password) {
        throw new Error(`${context}.url must be an HTTP or HTTPS URL without embedded credentials.`);
      }
      return { type: "http", url: url.href, ...timing };
    }
    default:
      throw new Error(`${context}.type must be "tcp" or "http".`);
  }
}

function positiveTimer(value: unknown, fallback: number, context: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_TIMER_MS) {
    throw new Error(`${context} must be an integer between 1 and ${MAX_TIMER_MS}.`);
  }
  return value;
}

function knownFields(raw: Record<string, unknown>, fields: Record<string, true>, context: string): void {
  for (const key of Object.keys(raw)) {
    if (!Object.hasOwn(fields, key)) throw new Error(`${context}: unknown field "${key}".`);
  }
}
