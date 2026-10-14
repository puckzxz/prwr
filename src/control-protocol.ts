import { isLogTail } from "./log-history.js";
import type { ControlCommand, ControlEnvelope } from "./types.js";

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

function isControlCommand(value: unknown): value is ControlCommand {
  if (!isRecord(value) || typeof value.type !== "string" || !Object.hasOwn(validators, value.type)) return false;
  return validators[value.type as ControlCommand["type"]](value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
