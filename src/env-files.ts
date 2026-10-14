import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "dotenv";

export function loadEnvFiles(value: unknown, configDir: string, context: string): Record<string, string> {
  if (value === undefined || value === null) {
    return {};
  }
  const files = typeof value === "string" ? [value] : value;
  if (!Array.isArray(files) || files.length === 0 || files.some((file) => typeof file !== "string" || !file.trim())) {
    throw new Error(`Invalid ${context}: envFile must be a path or a non-empty list of paths.`);
  }
  const env: Record<string, string> = {};
  for (const file of files as string[]) {
    const resolved = path.resolve(configDir, file);
    let contents: Buffer;
    try {
      contents = readFileSync(resolved);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "read failed";
      throw new Error(`Invalid ${context}: cannot read envFile ${resolved} (${code}).`);
    }
    mergeEnv(env, parse(contents));
  }
  return env;
}

export function resolveEnv(
  fileEnv: Record<string, string>,
  inlineEnv: Record<string, string>,
  inherited: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): Record<string, string> {
  const inheritedKeys = new Set(Object.keys(inherited).filter((key) => inherited[key] !== undefined)
    .map((key) => envKey(key, platform)));
  const defaults: Record<string, string> = {};
  mergeEnv(defaults, Object.fromEntries(Object.entries(fileEnv)
    .filter(([key]) => !inheritedKeys.has(envKey(key, platform)))), platform);
  mergeEnv(defaults, inlineEnv, platform);
  return defaults;
}

export function mergeEnv(
  target: NodeJS.ProcessEnv,
  source: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform
): void {
  for (const [key, value] of Object.entries(source)) {
    if (platform === "win32") {
      for (const existing of Object.keys(target)) {
        if (existing !== key && envKey(existing, platform) === envKey(key, platform)) {
          delete target[existing];
        }
      }
    }
    Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
  }
}

export function childEnvironment(
  overrides: Record<string, string>,
  inherited: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  mergeEnv(env, inherited, platform);
  if (!Object.keys(env).some((key) => envKey(key, platform) === envKey("FORCE_COLOR", platform)
    && env[key] !== undefined)) {
    mergeEnv(env, { FORCE_COLOR: "1" }, platform);
  }
  mergeEnv(env, overrides, platform);
  return env;
}

function envKey(key: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? key.toUpperCase() : key;
}
