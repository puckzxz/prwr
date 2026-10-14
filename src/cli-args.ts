import { DEFAULT_LOG_TAIL, isLogTail, MAX_LOG_TAIL } from "./log-history.js";
import { PUBLIC_CONTROL_COMMAND_TYPES, type PublicControlCommandType } from "./control-protocol.js";
import type { ColorMode, ControlCommand, ProcessSelection } from "./types.js";

interface ConfigOptions extends ProcessSelection {
  configPath?: string;
  procfilePath?: string;
  positionalPath?: string;
}

export type CliCommand =
  | ({ type: "up"; colorMode: ColorMode; timestamps: boolean } & ConfigOptions)
  | ({ type: "check" } & ConfigOptions)
  | { type: "control"; colorMode: ColorMode; command: ControlCommand; json?: boolean }
  | { type: "help" }
  | { type: "version" };

const CONTROL_COMMANDS: ReadonlySet<string> = new Set(PUBLIC_CONTROL_COMMAND_TYPES);

export function parseCliArgs(argv: string[]): CliCommand {
  const { args, colorMode, timestamps } = parseGlobalFlags(argv);
  const [command, ...rest] = args;

  if (command === "--help" || command === "-h" || command === "help") return { type: "help" };
  if (command === "--version" || command === "-v" || command === "version") return { type: "version" };
  if (command === "up" || command === "check") {
    const options = parseUpOptions(rest);
    return command === "up" ? { type: "up", colorMode, timestamps, ...options } : { type: "check", ...options };
  }

  if (isPublicControlCommand(command)) {
    const json = command === "status" && rest.includes("--json");
    const controlArgs = json ? rest.filter((arg) => arg !== "--json") : rest;
    return {
      type: "control", colorMode, command: parseControlCommand(command, controlArgs),
      ...(json ? { json: true } : {})
    };
  }

  return { type: "up", colorMode, timestamps, ...parseUpOptions(args) };
}

function isPublicControlCommand(command: string | undefined): command is PublicControlCommandType {
  return command !== undefined && CONTROL_COMMANDS.has(command);
}

export function isJsonStatusRequest(argv: string[]): boolean {
  const { args } = parseGlobalFlags(argv);
  return args[0] === "status" && args.includes("--json");
}

function parseGlobalFlags(argv: string[]): { args: string[]; colorMode: ColorMode; timestamps: boolean } {
  const args: string[] = [];
  let colorMode: ColorMode = "always";
  let timestamps = false;
  let literal = false;

  for (const arg of argv) {
    if (arg === "--") literal = true;
    if (!literal && arg === "--color") colorMode = "always";
    else if (!literal && arg === "--no-color") colorMode = "never";
    else if (!literal && arg === "--timestamps") timestamps = true;
    else args.push(arg);
  }

  return { args, colorMode, timestamps };
}

function parseUpOptions(args: string[]): ConfigOptions {
  const options: ConfigOptions = { configPath: undefined, procfilePath: undefined, positionalPath: undefined };
  let literal = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!literal && arg === "--") {
      literal = true;
    } else if (!literal && (arg === "--config" || arg === "--procfile")) {
      options[arg === "--config" ? "configPath" : "procfilePath"] = requireValue(args, index, arg);
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
