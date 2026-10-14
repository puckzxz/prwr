import path from "node:path";
import { validateProcessName } from "./procfile.js";
import { loadEnvFiles, mergeEnv, resolveEnv } from "./env-files.js";
import { normalizeReadiness } from "./readiness-config.js";
import type { ProcessConfig, RestartPolicy } from "./types.js";

const RESTART_POLICIES = new Set<RestartPolicy>(["manual", "always", "on-failure"]);
const PROCESS_FIELDS = new Set(Object.keys({
  command: true,
  cwd: true,
  env: true,
  envFile: true,
  dependsOn: true,
  readyWhen: true,
  restart: true,
  killOnExit: true,
  stdin: true,
  startupDelayMs: true,
  restartBackoffMs: true,
  restartBackoffMaxMs: true,
  restartBackoffResetMs: true,
  restartMaxAttempts: true
} satisfies Record<Exclude<keyof ProcessConfig, "name"> | "envFile", true>));

export function normalizeProcessConfig(
  name: string,
  value: unknown,
  configDir: string,
  globalEnv: Record<string, string> = {}
): ProcessConfig {
  validateProcessName(name);

  const raw = typeof value === "string" ? { command: value } : value;
  if (!isRecord(raw)) {
    throw new Error(`Invalid process "${name}": expected an object or command string.`);
  }

  validateKnownFields(Object.keys(raw), PROCESS_FIELDS, `process "${name}"`);

  if (typeof raw.command !== "string" || raw.command.trim().length === 0) {
    throw new Error(`Invalid process "${name}": command is required.`);
  }

  const cwd = normalizeCwd(name, raw.cwd, configDir);
  const files = { ...globalEnv };
  mergeEnv(files, loadEnvFiles(raw.envFile, configDir, `process "${name}"`));
  const env = resolveEnv(files, normalizeEnv(name, raw.env));
  const restart = normalizeRestart(name, raw.restart);
  const killOnExit = normalizeBoolean(name, "killOnExit", raw.killOnExit, false);
  const stdin = normalizeBoolean(name, "stdin", raw.stdin, false);
  const startupDelayMs = normalizeDelay(name, "startupDelayMs", raw.startupDelayMs);
  const restartBackoffMs = normalizeDelay(name, "restartBackoffMs", raw.restartBackoffMs);
  const restartBackoffMaxMs = normalizeDelay(name, "restartBackoffMaxMs", raw.restartBackoffMaxMs);
  const restartBackoffResetMs = normalizeDelay(name, "restartBackoffResetMs", raw.restartBackoffResetMs);
  const restartMaxAttempts = normalizeCount(name, "restartMaxAttempts", raw.restartMaxAttempts);

  return {
    name,
    command: raw.command,
    cwd,
    env,
    dependsOn: normalizeDependencies(name, raw.dependsOn),
    readyWhen: normalizeReadiness(raw.readyWhen, name),
    restart,
    killOnExit,
    stdin,
    startupDelayMs,
    restartBackoffMs,
    restartBackoffMaxMs,
    restartBackoffResetMs,
    restartMaxAttempts
  };
}

function normalizeCwd(name: string, value: unknown, configDir: string): string {
  if (value === undefined || value === null) {
    return configDir;
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid process "${name}": cwd must be a non-empty string.`);
  }

  return path.resolve(configDir, value);
}

function normalizeEnv(name: string, value: unknown): Record<string, string> {
  if (value === undefined || value === null) {
    return {};
  }

  if (!isRecord(value)) {
    throw new Error(`Invalid process "${name}": env must be an object.`);
  }

  const env: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(value)) {
    if (rawValue === undefined || rawValue === null) {
      continue;
    }

    if (
      typeof rawValue !== "string" &&
      typeof rawValue !== "number" &&
      typeof rawValue !== "boolean"
    ) {
      throw new Error(`Invalid process "${name}": env.${key} must be a scalar value.`);
    }

    Object.defineProperty(env, key, { value: String(rawValue), enumerable: true });
  }

  return env;
}

function normalizeRestart(name: string, value: unknown): RestartPolicy {
  if (value === undefined || value === null) {
    return "manual";
  }

  if (typeof value !== "string" || !RESTART_POLICIES.has(value as RestartPolicy)) {
    throw new Error(
      `Invalid process "${name}": restart must be manual, always, or on-failure.`
    );
  }

  return value as RestartPolicy;
}

function normalizeBoolean(
  name: string,
  field: string,
  value: unknown,
  defaultValue: boolean
): boolean {
  if (value === undefined || value === null) {
    return defaultValue;
  }

  if (typeof value !== "boolean") {
    throw new Error(`Invalid process "${name}": ${field} must be a boolean.`);
  }

  return value;
}

function normalizeDelay(name: string, field: string, value: unknown): number {
  if (value === undefined || value === null) {
    return 0;
  }

  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid process "${name}": ${field} must be a non-negative number.`);
  }

  return value;
}

function normalizeCount(name: string, field: string, value: unknown): number {
  if (value === undefined || value === null) {
    return 0;
  }

  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    !Number.isFinite(value) ||
    value < 0
  ) {
    throw new Error(`Invalid process "${name}": ${field} must be a non-negative integer.`);
  }

  return value;
}

function validateKnownFields(
  fields: string[],
  allowedFields: Set<string>,
  context: string
): void {
  for (const field of fields) {
    if (!allowedFields.has(field)) {
      throw new Error(`Invalid .prwr.yml: unknown ${context} field "${field}".`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeDependencies(name: string, value: unknown): string[] {
  if (value === undefined || value === null) return [];
  const names = typeof value === "string" ? [value] : value;
  if (!Array.isArray(names) || names.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new Error(`Invalid process "${name}": dependsOn must be a process name or list of names.`);
  }
  for (const dependency of names as string[]) validateProcessName(dependency);
  return [...new Set(names as string[])];
}
