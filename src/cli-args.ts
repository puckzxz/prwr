import { DEFAULT_LOG_TAIL, isLogTail, MAX_LOG_TAIL } from "./log-history.js";
import { PUBLIC_CONTROL_COMMAND_TYPES, type PublicControlCommandType } from "./control-protocol.js";
import { DEFAULT_WAIT_TIMEOUT_MS, validateWaitTimeout } from "./process-wait.js";
import type { ColorMode, ControlCommand, ProcessSelection, ProcessWaitOptions } from "./types.js";

interface ConfigOptions extends ProcessSelection {
  configPath?: string;
  procfilePath?: string;
  positionalPath?: string;
}

export type CliCommand =
  | ({ type: "up"; colorMode: ColorMode; timestamps: boolean } & ConfigOptions)
  | ({ type: "check" } & ConfigOptions)
  | { type: "control"; colorMode: ColorMode; command: ControlCommand; json?: boolean; configPath?: string }
  | ({ type: "wait"; json: boolean } & ProcessWaitOptions)
  | { type: "help" }
  | { type: "version" };

const CONTROL_COMMANDS: ReadonlySet<string> = new Set(PUBLIC_CONTROL_COMMAND_TYPES);

export function parseCliArgs(argv: string[]): CliCommand {
  const { args, colorMode, timestamps, configPath } = parseGlobalFlags(argv);
  const [command, ...rest] = args;
  const target = configPath === undefined ? {} : { configPath };

  if (command === "--help" || command === "-h" || command === "help") return { type: "help" };
  if (command === "--version" || command === "-v" || command === "version") return { type: "version" };
  if (command === "up" || command === "check") {
    const options = parseUpOptions(rest);
    return command === "up" ? { type: "up", colorMode, timestamps, ...options, ...target } : { type: "check", ...options, ...target };
  }
  if (command === "wait") return { type: "wait", ...parseWaitOptions(rest), ...target };

  if (isPublicControlCommand(command)) {
    const { args: controlArgs, json } = command === "status" ? extractJsonFlag(rest) : { args: rest, json: false };
    return {
      type: "control", colorMode, command: parseControlCommand(command, controlArgs), ...target,
      ...(json ? { json: true } : {})
    };
  }

  return { type: "up", colorMode, timestamps, ...parseUpOptions(args), ...target };
}

function isPublicControlCommand(command: string | undefined): command is PublicControlCommandType {
  return command !== undefined && CONTROL_COMMANDS.has(command);
}

export function isJsonRequest(argv: string[]): boolean {
  // Detect error-output mode even when malformed global options prevent parsing.
  let command: string | undefined;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--") break;
    if (arg === "--json") json = true;
    else if (arg === "--color" || arg === "--no-color" || arg === "--timestamps" || arg.startsWith("--config=")) continue;
    else if (arg === "--config") {
      if (argv[index + 1] && !argv[index + 1]!.startsWith("--")) index += 1;
    } else command ??= arg;
  }
  return (command === "status" || command === "wait") && json;
}

function parseGlobalFlags(argv: string[]): { args: string[]; colorMode: ColorMode; timestamps: boolean; configPath?: string } {
  const args: string[] = [];
  let colorMode: ColorMode = "always";
  let timestamps = false;
  let configPath: string | undefined;
  let literal = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--") literal = true;
    if (!literal && arg === "--color") colorMode = "always";
    else if (!literal && arg === "--no-color") colorMode = "never";
    else if (!literal && arg === "--timestamps") timestamps = true;
    else if (!literal && (arg === "--config" || arg.startsWith("--config="))) {
      if (configPath !== undefined) throw new Error("Option --config may only be specified once.");
      configPath = arg === "--config" ? requireValue(argv, index, arg) : arg.slice("--config=".length);
      if (arg === "--config") index += 1;
      if (!configPath.trim()) throw new Error("Option --config requires a nonempty path.");
    } else args.push(arg);
  }

  return { args, colorMode, timestamps, configPath };
}

function parseUpOptions(args: string[]): ConfigOptions {
  const options: ConfigOptions = { configPath: undefined, procfilePath: undefined, positionalPath: undefined };
  let literal = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!literal && arg === "--") {
      literal = true;
    } else if (!literal && arg === "--procfile") {
      options.procfilePath = requireValue(args, index, arg);
      index += 1;
    } else if (!literal && (arg === "--only" || arg === "--exclude" || arg.startsWith("--only=") || arg.startsWith("--exclude="))) {
      const equals = arg.indexOf("=");
      const option = equals === -1 ? arg : arg.slice(0, equals);
      const names = parseNames(equals === -1 ? requireValue(args, index, option) : arg.slice(equals + 1), option);
      const key = option === "--only" ? "only" : "exclude";
      options[key] = [...new Set([...(options[key] ?? []), ...names])];
      if (equals === -1) index += 1;
    } else if (!literal && arg.startsWith("-")) {
      throw new Error(`Unknown option "${arg}".`);
    } else if (!options.positionalPath) {
      options.positionalPath = arg;
    } else {
      throw new Error(`Unexpected argument "${arg}".`);
    }
  }

  return options;
}

function extractJsonFlag(args: string[]): { args: string[]; json: boolean } {
  let literal = false;
  let json = false;
  const remaining = args.filter((arg) => {
    if (arg === "--") literal = true;
    if (literal || arg !== "--json") return true;
    json = true;
    return false;
  });
  return { args: remaining, json };
}

function parseWaitOptions(args: string[]): Pick<Extract<CliCommand, { type: "wait" }>, "names" | "timeoutMs" | "json"> {
  const { args: remaining, json } = extractJsonFlag(args);
  const names: string[] = [];
  let timeoutMs = DEFAULT_WAIT_TIMEOUT_MS;
  let literal = false;
  let timeoutSeen = false;
  for (let index = 0; index < remaining.length; index += 1) {
    const arg = remaining[index]!;
    if (!literal && arg === "--") literal = true;
    else if (!literal && (arg === "--timeout" || arg.startsWith("--timeout="))) {
      if (timeoutSeen) throw new Error("Option --timeout may only be specified once.");
      timeoutSeen = true;
      const value = arg === "--timeout" ? requireValue(remaining, index, arg) : arg.slice("--timeout=".length);
      if (arg === "--timeout") index += 1;
      timeoutMs = /^\d+$/.test(value) ? Number(value) : NaN;
      validateWaitTimeout(timeoutMs);
    } else if (!literal && arg.startsWith("-")) throw new Error(`Unknown option "${arg}".`);
    else names.push(arg);
  }
  return { names: [...new Set(names)], timeoutMs, json };
}

function parseNames(value: string, option: string): string[] {
  const names = value.split(",").map((name) => name.trim());
  if (names.some((name) => !name)) throw new Error(`Option ${option} requires nonempty process names.`);
  return names;
}

function parseControlCommand(command: PublicControlCommandType, args: string[]): ControlCommand {
  if (command === "down" || command === "status") {
    if (args.length) throw new Error(`Command "${command}" does not accept arguments.`);
    return { type: command };
  }

  if (args[0] === "--") args = args.slice(1);
  const name = args[0];
  if (!name) throw new Error(`Command "${command}" requires a process name.`);
  if (command === "send") {
    const text = args.slice(args[1] === "--" ? 2 : 1).join(" ");
    if (!text) throw new Error('Command "send" requires text to send.');
    return { type: "send", name, text };
  }
  if (command === "logs") return { type: "logs", name, tail: parseLogTail(args.slice(1)) };
  if (args.length > 1) throw new Error(`Unexpected argument "${args[1]}".`);
  switch (command) {
    case "restart":
    case "stop":
    case "start":
      return { type: command, name };
    default:
      return assertNeverCommand(command);
  }
}

function assertNeverCommand(command: never): never {
  throw new Error(`Unhandled control command: ${String(command)}`);
}

function parseLogTail(args: string[]): number {
  if (!args.length) return DEFAULT_LOG_TAIL;
  if (args[0] !== "--tail") throw new Error(`Unknown option "${args[0]}".`);
  if (args.length === 1) return DEFAULT_LOG_TAIL;
  if (args.length > 2) throw new Error(`Unexpected argument "${args[2]}".`);
  const tail = /^\d+$/.test(args[1]!) ? Number(args[1]) : NaN;
  if (!isLogTail(tail)) throw new Error(`Log tail must be an integer between 0 and ${MAX_LOG_TAIL}.`);
  return tail;
}

function requireValue(args: string[], index: number, option: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Option ${option} requires a value.`);
  return value;
}
