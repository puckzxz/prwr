#!/usr/bin/env node
import path from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runUp, sendProjectCommand } from "./supervisor.js";
import type { ColorMode, ControlCommand, SupervisorStatus } from "./types.js";

type CliCommand =
  | { type: "up"; colorMode: ColorMode; configPath?: string; procfilePath?: string; positionalPath?: string }
  | { type: "control"; colorMode: ColorMode; command: ControlCommand }
  | { type: "help" }
  | { type: "version" };

const CONTROL_COMMANDS = new Set(["down", "restart", "stop", "start", "status"]);

export function parseCliArgs(argv: string[]): CliCommand {
  const { args, colorMode } = parseGlobalFlags(argv);

  if (args.length === 0) {
    return { type: "up", colorMode };
  }

  const [command, ...rest] = args;

  if (command === "--help" || command === "-h" || command === "help") {
    return { type: "help" };
  }

  if (command === "--version" || command === "-v" || command === "version") {
    return { type: "version" };
  }

  if (command === "up") {
    return { type: "up", colorMode, ...parseUpOptions(rest) };
  }

  if (CONTROL_COMMANDS.has(command ?? "")) {
    return { type: "control", colorMode, command: parseControlCommand(command ?? "", rest) };
  }

  if (command?.startsWith("-")) {
    throw new Error(`Unknown option "${command}".`);
  }

  if (rest.length > 0) {
    throw new Error(`Unexpected argument "${rest[0]}".`);
  }

  return { type: "up", colorMode, positionalPath: command };
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const command = parseCliArgs(argv);

  switch (command.type) {
    case "help":
      printUsage();
      return 0;
    case "version":
      console.log("0.1.0");
      return 0;
    case "up":
      return runUp({
        cwd: process.cwd(),
        colorMode: command.colorMode,
        configPath: command.configPath,
        procfilePath: command.procfilePath,
        positionalPath: command.positionalPath
      });
    case "control": {
      const response = await sendProjectCommand(process.cwd(), command.command);
      if (!response.ok) {
        console.error(response.error);
        return 1;
      }

      if (command.command.type === "status") {
        printStatus(response.data as SupervisorStatus);
      } else if (response.data && typeof response.data === "object" && "message" in response.data) {
        console.log(String((response.data as { message: unknown }).message));
      }

      return 0;
    }
    default:
      return assertNever(command);
  }
}

function parseGlobalFlags(argv: string[]): { args: string[]; colorMode: ColorMode } {
  const args: string[] = [];
  let colorMode: ColorMode = "always";

  for (const arg of argv) {
    if (arg === "--color") {
      colorMode = "always";
    } else if (arg === "--no-color") {
      colorMode = "never";
    } else {
      args.push(arg);
    }
  }

  return { args, colorMode };
}

function parseUpOptions(args: string[]): {
  configPath?: string;
  procfilePath?: string;
  positionalPath?: string;
} {
  let configPath: string | undefined;
  let procfilePath: string | undefined;
  let positionalPath: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";

    if (arg === "--config") {
      configPath = requireValue(args, index, "--config");
      index += 1;
    } else if (arg === "--procfile") {
      procfilePath = requireValue(args, index, "--procfile");
      index += 1;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option "${arg}".`);
    } else if (!positionalPath) {
      positionalPath = arg;
    } else {
      throw new Error(`Unexpected argument "${arg}".`);
    }
  }

  return { configPath, procfilePath, positionalPath };
}

function parseControlCommand(command: string, args: string[]): ControlCommand {
  if (command === "down" || command === "status") {
    if (args.length > 0) {
      throw new Error(`Command "${command}" does not accept arguments.`);
    }

    return { type: command };
  }

  const name = args[0];
  if (!name) {
    throw new Error(`Command "${command}" requires a process name.`);
  }

  if (args.length > 1) {
    throw new Error(`Unexpected argument "${args[1]}".`);
  }

  return { type: command as "restart" | "stop" | "start", name };
}

function requireValue(args: string[], index: number, option: string): string {
  const value = args[index + 1];
  if (!value) {
    throw new Error(`Option ${option} requires a value.`);
  }

  return value;
}

function printUsage(): void {
  console.log(`Usage:
  prwr [--color|--no-color]
  prwr up [--config ./.prwr.yml] [--procfile ./Procfile.dev] [--color|--no-color]
  prwr ./.prwr.yml
  prwr ./Procfile.dev
  prwr status
  prwr restart <name>
  prwr stop <name>
  prwr start <name>
  prwr down

Labels are colored by default. Use --no-color or NO_COLOR=1 to disable colors.`);
}

function printStatus(status: SupervisorStatus): void {
  console.log(`Supervisor pid=${status.supervisor.supervisorPid} startedAt=${status.supervisor.startedAt}`);
  console.log(`Config ${path.relative(process.cwd(), status.supervisor.configPath) || status.supervisor.configPath}`);

  const rows = status.processes.map((processStatus) => ({
    name: processStatus.name,
    state: processStatus.state,
    pid: processStatus.pid === null ? "-" : String(processStatus.pid),
    restarts: String(processStatus.restartCount),
    exit: processStatus.lastExitCode === null ? "-" : String(processStatus.lastExitCode),
    command: processStatus.command
  }));

  const widths = {
    name: Math.max("name".length, ...rows.map((row) => row.name.length)),
    state: Math.max("state".length, ...rows.map((row) => row.state.length)),
    pid: Math.max("pid".length, ...rows.map((row) => row.pid.length)),
    restarts: Math.max("restarts".length, ...rows.map((row) => row.restarts.length)),
    exit: Math.max("exit".length, ...rows.map((row) => row.exit.length))
  };

  console.log(
    `${"name".padEnd(widths.name)}  ${"state".padEnd(widths.state)}  ${"pid".padEnd(widths.pid)}  ${"restarts".padEnd(widths.restarts)}  ${"exit".padEnd(widths.exit)}  command`
  );

  for (const row of rows) {
    console.log(
      `${row.name.padEnd(widths.name)}  ${row.state.padEnd(widths.state)}  ${row.pid.padEnd(widths.pid)}  ${row.restarts.padEnd(widths.restarts)}  ${row.exit.padEnd(widths.exit)}  ${row.command}`
    );
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled command: ${String(value)}`);
}

if (isDirectRun()) {
  main().then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  );
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }

  try {
    return realpathSync.native(path.resolve(entry)) === realpathSync.native(fileURLToPath(import.meta.url));
  } catch {
    return path.resolve(entry) === fileURLToPath(import.meta.url);
  }
}
