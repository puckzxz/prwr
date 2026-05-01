import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { parseProcfile, validateProcessName } from "./procfile.js";
import type { LoadedConfig, ProcessConfig, RestartPolicy } from "./types.js";

const CONFIG_SEARCH_ORDER = [".prwr.yml", ".prwr.yaml", "Procfile.dev", "Procfile"];
const RESTART_POLICIES = new Set<RestartPolicy>(["manual", "always", "on-failure"]);
const TOP_LEVEL_FIELDS = new Set(["processes"]);
const PROCESS_FIELDS = new Set([
  "command",
  "cwd",
  "env",
  "restart",
  "killOnExit",
  "stdin",
  "startupDelayMs",
  "restartBackoffMs",
  "restartBackoffMaxMs",
  "restartBackoffResetMs",
  "restartMaxAttempts"
]);

export interface LoadConfigOptions {
  cwd: string;
  configPath?: string;
  procfilePath?: string;
  positionalPath?: string;
}

export function findConfig(cwd: string): string | null {
  for (const fileName of CONFIG_SEARCH_ORDER) {
    const candidate = path.resolve(cwd, fileName);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function loadConfig(options: LoadConfigOptions): LoadedConfig {
  const selected = selectConfigPath(options);
  if (!selected) {
    throw new Error(
      `No prwr config found. Expected one of: ${CONFIG_SEARCH_ORDER.join(", ")}.`
    );
  }

  const configPath = path.resolve(options.cwd, selected.path);
  const configDir = path.dirname(configPath);
  const source = readFileSync(configPath, "utf8");

  if (selected.kind === "procfile" || isProcfilePath(configPath)) {
    return loadProcfileConfig(configPath, configDir, source);
  }

  return loadYamlConfig(configPath, configDir, source);
}

function selectConfigPath(
  options: LoadConfigOptions
): { path: string; kind: "yaml" | "procfile" } | null {
  if (options.configPath && options.procfilePath) {
    throw new Error("Use either --config or --procfile, not both.");
  }

  if (options.configPath) {
    return { path: options.configPath, kind: "yaml" };
  }

  if (options.procfilePath) {
    return { path: options.procfilePath, kind: "procfile" };
  }

  if (options.positionalPath) {
    const positionalPath = path.resolve(options.cwd, options.positionalPath);
    if (existsSync(positionalPath) && statSync(positionalPath).isDirectory()) {
      throw new Error(`Expected a config file but received a directory: ${options.positionalPath}`);
    }

    return {
      path: options.positionalPath,
      kind: isProcfilePath(options.positionalPath) ? "procfile" : "yaml"
    };
  }

  const discovered = findConfig(options.cwd);
  if (!discovered) {
    return null;
  }

  return {
    path: discovered,
    kind: isProcfilePath(discovered) ? "procfile" : "yaml"
  };
}

function isProcfilePath(filePath: string): boolean {
  const baseName = path.basename(filePath);
  const extension = path.extname(filePath);
  return baseName === "Procfile" || baseName === "Procfile.dev" || extension === "";
}

function loadProcfileConfig(configPath: string, configDir: string, source: string): LoadedConfig {
  const entries = parseProcfile(source);
  const processes = entries.map<ProcessConfig>((entry) => ({
    name: entry.name,
    command: entry.command,
    cwd: configDir,
    env: {},
    restart: "manual",
    killOnExit: false,
    stdin: false,
    startupDelayMs: 0,
    restartBackoffMs: 0,
    restartBackoffMaxMs: 0,
    restartBackoffResetMs: 0,
    restartMaxAttempts: 0
  }));

  return {
    configPath,
    configDir,
    projectRoot: configDir,
    sourceType: "procfile",
    processes
  };
}

function loadYamlConfig(configPath: string, configDir: string, source: string): LoadedConfig {
  const parsed = YAML.parse(source) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("Invalid .prwr.yml: expected an object.");
  }

  validateKnownFields(Object.keys(parsed), TOP_LEVEL_FIELDS, "top-level");

  const processesValue = parsed.processes;
  if (!isRecord(processesValue)) {
    throw new Error('Invalid .prwr.yml: expected a "processes" object.');
  }

  const names = Object.keys(processesValue);
  if (names.length === 0) {
    throw new Error("Invalid .prwr.yml: processes must not be empty.");
  }

  const processes = names.map((name) =>
    normalizeProcessConfig(name, processesValue[name], configDir)
  );

  return {
    configPath,
    configDir,
    projectRoot: configDir,
    sourceType: "yaml",
    processes
  };
}

function normalizeProcessConfig(
  name: string,
  value: unknown,
  configDir: string
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
  const env = normalizeEnv(name, raw.env);
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

    env[key] = String(rawValue);
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
