import { isLogTail } from "./log-history.js";
import type { ControlCommand, ControlEnvelope, ProcessRunState, ProcessStatus, SupervisorIdentity, SupervisorStatus } from "./types.js";

type Validator = (value: Record<string, unknown>) => boolean;
const hasName: Validator = (value) => typeof value.name === "string" && value.name.length > 0;
const validators = {
  status: () => true,
  identity: () => true,
  down: () => true,
  start: hasName,
  stop: hasName,
  restart: hasName,
  send: (value) => hasName(value) && typeof value.text === "string",
  logs: (value) => hasName(value) && isLogTail(value.tail)
} satisfies Record<ControlCommand["type"], Validator>;

export type PublicControlCommandType = Exclude<ControlCommand["type"], "identity">;
export const PUBLIC_CONTROL_COMMAND_TYPES = Object.keys(validators)
  .filter((type) => type !== "identity") as PublicControlCommandType[];

export function isControlEnvelope(value: unknown): value is ControlEnvelope {
  return isRecord(value) && typeof value.token === "string" && value.token.length > 0 &&
    isControlCommand(value.command);
}

export function isSupervisorIdentity(value: unknown): value is SupervisorIdentity {
  return isRecord(value) && isPositiveInteger(value.supervisorPid) &&
    typeof value.projectRoot === "string" && typeof value.configPath === "string" && typeof value.startedAt === "string";
}

export function sameSupervisorIdentity(left: SupervisorIdentity, right: SupervisorIdentity): boolean {
  return left.supervisorPid === right.supervisorPid && left.startedAt === right.startedAt &&
    left.projectRoot === right.projectRoot && left.configPath === right.configPath;
}

const PROCESS_STATES = {
  starting: true, running: true, stopped: true, restarting: true, failed: true
} satisfies Record<ProcessRunState, true>;

export function isSupervisorStatus(value: unknown): value is SupervisorStatus {
  if (!isRecord(value) || !isRecord(value.supervisor) || !isSupervisorIdentity(value.supervisor) ||
    !isPositiveInteger(value.supervisor.port) || value.supervisor.port > 65535 ||
    !Array.isArray(value.processes) || !value.processes.length || !value.processes.every(isProcessStatus)) return false;
  return new Set(value.processes.map(({ name }) => name)).size === value.processes.length;
}

function isProcessStatus(value: unknown): value is ProcessStatus {
  return isRecord(value) && typeof value.name === "string" && value.name.length > 0 &&
    typeof value.state === "string" && Object.hasOwn(PROCESS_STATES, value.state) &&
    (value.pid === null || isPositiveInteger(value.pid)) &&
    typeof value.command === "string" && typeof value.cwd === "string" &&
    (value.lastExitCode === null || Number.isInteger(value.lastExitCode)) &&
    (value.lastSignal === null || typeof value.lastSignal === "string") &&
    Number.isInteger(value.restartCount) && (value.restartCount as number) >= 0 &&
    (value.lastError === null || typeof value.lastError === "string");
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isControlCommand(value: unknown): value is ControlCommand {
  if (!isRecord(value) || typeof value.type !== "string" || !Object.hasOwn(validators, value.type)) return false;
  return validators[value.type as ControlCommand["type"]](value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
