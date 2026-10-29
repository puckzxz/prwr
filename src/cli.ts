#!/usr/bin/env node
import path from "node:path";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runCheck, runUp, sendProjectCommand } from "./supervisor.js";
import { isJsonRequest, parseCliArgs, type CliCommand } from "./cli-args.js";
import { printFailure, printJsonStatus, printLogs, printStatus, printUsage } from "./cli-output.js";
import { waitForProcesses } from "./process-wait.js";
import type { ProcessLogs, ProcessStatus, SupervisorStatus } from "./types.js";

export { parseCliArgs } from "./cli-args.js";

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let command: CliCommand;
  try {
    command = parseCliArgs(argv);
  } catch (error) {
    if (isJsonRequest(argv)) return printFailure(errorMessage(error), true);
    throw error;
  }

  switch (command.type) {
    case "help":
      printUsage();
      return 0;
    case "version":
      console.log(packageVersion());
      return 0;
    case "check":
      return runCheck({
        cwd: process.cwd(),
        configPath: command.configPath,
        procfilePath: command.procfilePath,
        positionalPath: command.positionalPath,
        only: command.only,
        exclude: command.exclude
      });
    case "up":
      return runUp({
        cwd: process.cwd(),
        colorMode: command.colorMode,
        timestamps: command.timestamps,
        configPath: command.configPath,
        procfilePath: command.procfilePath,
        positionalPath: command.positionalPath,
        only: command.only,
        exclude: command.exclude
      });
    case "control":
      return runControl(command);
    case "wait":
      return runWait(command);
    default:
      return assertNever(command);
  }
}

async function runControl(command: Extract<CliCommand, { type: "control" }>): Promise<number> {
  try {
    const response = command.configPath === undefined
      ? await sendProjectCommand(process.cwd(), command.command)
      : await sendProjectCommand(process.cwd(), command.command, { configPath: command.configPath });
    if (!response.ok) return printFailure(response.error, command.json);

    if (command.command.type === "status") {
      if (command.json) printJsonStatus(response.data as SupervisorStatus);
      else printStatus(response.data as SupervisorStatus);
    } else if (command.command.type === "logs") {
      printLogs(response.data as ProcessLogs, command.colorMode);
    } else if ((command.command.type === "start" || command.command.type === "restart" || command.command.type === "stop") &&
      (response.data as ProcessStatus)?.state === "failed") {
      const status = response.data as ProcessStatus;
      return printFailure(`Failed to ${command.command.type} "${command.command.name}": ${status.lastError ?? "process operation failed."}`);
    } else if (response.data && typeof response.data === "object" && "message" in response.data) {
      console.log(String((response.data as { message: unknown }).message));
    }
    return 0;
  } catch (error) {
    if (command.json) return printFailure(errorMessage(error), true);
    throw error;
  }
}

async function runWait(command: Extract<CliCommand, { type: "wait" }>): Promise<number> {
  const controller = new AbortController();
  const onSignal = () => controller.abort(new Error("prwr wait interrupted."));
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    const status = await waitForProcesses(process.cwd(), { ...command, signal: controller.signal });
    if (command.json) printJsonStatus(status);
    else console.log(`prwr ready: ${(command.names.length ? command.names : status.processes.map(({ name }) => name)).join(", ")}`);
    return 0;
  } catch (error) {
    return printFailure(errorMessage(error), command.json);
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertNever(value: never): never {
  throw new Error(`Unhandled command: ${String(value)}`);
}

function packageVersion(): string {
  const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
  const parsed = JSON.parse(raw) as { version?: unknown };
  if (typeof parsed.version !== "string") {
    throw new Error("package.json is missing a version.");
  }

  return parsed.version;
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
