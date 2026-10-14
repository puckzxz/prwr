import path from "node:path";
import { colorForName, shouldColorLabels } from "./logger.js";
import type { ColorMode, ProcessLogs, SupervisorStatus } from "./types.js";

export function printUsage(): void {
  console.log(`Usage:
  prwr [--color|--no-color] [--timestamps]
  prwr up [--config ./.prwr.yml] [--procfile ./Procfile.dev] [--only <names>] [--exclude <names>]
  prwr ./.prwr.yml
  prwr ./Procfile.dev
  prwr status [--json]
  prwr logs <name> [--tail [N]] [--color|--no-color]
  prwr restart <name>
  prwr stop <name>
  prwr start <name>
  prwr send <name> [--] <text>
  prwr down
  prwr check [--config ./.prwr.yml] [--only <names>] [--exclude <names>]

Labels are colored by default. Use --no-color or NO_COLOR=1 to disable label colors.
Use --timestamps to prefix live log lines with local HH:mm:ss timestamps.
Selection accepts comma-separated names and repeated flags. Dependencies are included automatically.
Logs show recent timestamped output; --tail defaults to 50 entries.`);
}

export function printStatus(status: SupervisorStatus): void {
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
  const columns = ["name", "state", "pid", "restarts", "exit", "command"] as const;
  const widths = columns.map((column) => Math.max(column.length, ...rows.map((row) => row[column].length)));
  console.log(columns.map((column, index) => index === columns.length - 1 ? column : column.padEnd(widths[index]!)).join("  "));
  for (const row of rows) {
    console.log(columns.map((column, index) => index === columns.length - 1 ? row[column] : row[column].padEnd(widths[index]!)).join("  "));
  }
}

export function printJsonStatus(status: SupervisorStatus): void {
  // Project public fields explicitly: runtime state and environment are never part of this output.
  const { supervisorPid, projectRoot, configPath, port, startedAt } = status.supervisor;
  const publicStatus = {
    supervisor: { supervisorPid, projectRoot, configPath, port, startedAt },
    processes: status.processes.map(({ name, state, pid, command, cwd, lastExitCode, lastSignal, restartCount, lastError }) => ({
      name, state, pid, command, cwd, lastExitCode, lastSignal, restartCount, lastError
    }))
  } satisfies SupervisorStatus;
  console.log(JSON.stringify(publicStatus));
}

export function printLogs(logs: ProcessLogs, colorMode: ColorMode): void {
  for (const entry of logs.entries) {
    const stream = entry.stream === "stderr" ? process.stderr : process.stdout;
    const prefix = `${entry.name} | `;
    stream.write(`${entry.timestamp} ${shouldColorLabels(colorMode, stream) ? colorForName(entry.name, prefix) : prefix}${entry.text}\n`);
  }
}

export function printFailure(error: string, json = false): number {
  if (json) console.log(JSON.stringify({ ok: false, error }));
  else console.error(error);
  return 1;
}
