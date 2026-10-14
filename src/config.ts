import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { parseProcfile } from "./procfile.js";
import { normalizeProcessConfig } from "./process-config.js";
import { loadEnvFiles } from "./env-files.js";
import { orderedProcesses } from "./process-graph.js";
import type { LoadedConfig } from "./types.js";

const CONFIG_SEARCH_ORDER = [".prwr.yml", ".prwr.yaml", "Procfile.dev", "Procfile"];
const TOP_LEVEL_FIELDS = new Set(["processes", "envFile"]);

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
  const processes = entries.map((entry) => normalizeProcessConfig(entry.name, entry.command, configDir));

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

  const globalEnv = loadEnvFiles(parsed.envFile, configDir, "top-level");
  const processes = names.map((name) =>
    normalizeProcessConfig(name, processesValue[name], configDir, globalEnv)
  );
  orderedProcesses(processes);

  return {
    configPath,
    configDir,
    projectRoot: configDir,
    sourceType: "yaml",
    processes
  };
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
