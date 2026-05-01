import type { ChildProcess } from "node:child_process";

export type RestartPolicy = "manual" | "always" | "on-failure";

export type ProcessRunState = "running" | "stopped" | "restarting" | "failed";

export interface ProcessConfig {
  name: string;
  command: string;
  cwd: string;
  env: Record<string, string>;
  restart: RestartPolicy;
  killOnExit: boolean;
  stdin: boolean;
  startupDelayMs: number;
  restartBackoffMs: number;
  restartBackoffMaxMs: number;
  restartBackoffResetMs: number;
  restartMaxAttempts: number;
}

export interface LoadedConfig {
  configPath: string;
  configDir: string;
  projectRoot: string;
  sourceType: "yaml" | "procfile";
  processes: ProcessConfig[];
}

export interface ProcessStatus {
  name: string;
  state: ProcessRunState;
  pid: number | null;
  command: string;
  cwd: string;
  lastExitCode: number | null;
  lastSignal: NodeJS.Signals | null;
  restartCount: number;
  lastError: string | null;
}

export interface ManagedProcess extends ProcessStatus {
  config: ProcessConfig;
  child: ChildProcess | null;
  stopRequested: boolean;
  restartTimer: NodeJS.Timeout | null;
  restartAttempts: number;
  lastStartedAt: number | null;
}

export interface SupervisorStateFile {
  supervisorPid: number;
  projectRoot: string;
  configPath: string;
  port: number;
  token: string;
  startedAt: string;
}

export type PublicSupervisorState = Omit<SupervisorStateFile, "token">;

export type ControlCommand =
  | { type: "status" }
  | { type: "identity" }
  | { type: "restart"; name: string }
  | { type: "stop"; name: string }
  | { type: "start"; name: string }
  | { type: "send"; name: string; text: string }
  | { type: "down" };

export type ControlResponse =
  | { ok: true; data: unknown }
  | { ok: false; error: string };

export interface SupervisorStatus {
  supervisor: PublicSupervisorState;
  processes: ProcessStatus[];
}

export interface SupervisorIdentity {
  supervisorPid: number;
  projectRoot: string;
  configPath: string;
  startedAt: string;
}

export type ColorMode = "auto" | "always" | "never";
