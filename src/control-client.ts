import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { isPidAlive } from "./kill-tree.js";
import { DEFAULT_MAX_CONTROL_RESPONSE_BYTES } from "./control-server.js";
import type {
  ControlCommand,
  ControlEnvelope,
  ControlResponse,
  SupervisorIdentity,
  SupervisorStateFile
} from "./types.js";

const RUNTIME_DIR_NAME = ".prwr";
const STATE_FILE_NAME = "supervisor.json";
const DEFAULT_CONTROL_CLIENT_TIMEOUT_MS = 5000;
const START_CONTROL_CLIENT_TIMEOUT_MS = 60000;

interface ControlExchange {
  response: ControlResponse;
  transportFailed: boolean;
}

export function runtimeDir(projectRoot: string): string {
  return path.join(projectRoot, RUNTIME_DIR_NAME);
}

export function stateFilePath(projectRoot: string): string {
  return path.join(runtimeDir(projectRoot), STATE_FILE_NAME);
}

export function writeSupervisorState(state: SupervisorStateFile): void {
  mkdirSync(runtimeDir(state.projectRoot), { recursive: true });
  writeFileSync(stateFilePath(state.projectRoot), `${JSON.stringify(state, null, 2)}\n`);
}

export function removeSupervisorState(projectRoot: string): void {
  rmSync(stateFilePath(projectRoot), { force: true });
}

export function readSupervisorState(projectRoot: string): SupervisorStateFile | null {
  const filePath = stateFilePath(projectRoot);
  if (!existsSync(filePath)) {
    return null;
  }

  let parsed: unknown;
  try {
    const raw = readFileSync(filePath, "utf8");
    parsed = JSON.parse(raw);
  } catch {
    removeSupervisorState(projectRoot);
    return null;
  }

  if (
    !isValidState(parsed) ||
    path.relative(projectRoot, parsed.projectRoot) !== "" ||
    !isPidAlive(parsed.supervisorPid)
  ) {
    removeSupervisorState(projectRoot);
    return null;
  }

  return parsed;
}

function isValidState(value: unknown): value is SupervisorStateFile {
  return (
    isRecord(value) &&
    typeof value.supervisorPid === "number" &&
    Number.isInteger(value.supervisorPid) &&
    value.supervisorPid > 0 &&
    typeof value.projectRoot === "string" &&
    value.projectRoot.length > 0 &&
    typeof value.configPath === "string" &&
    value.configPath.length > 0 &&
    typeof value.port === "number" &&
    Number.isInteger(value.port) &&
    value.port > 0 &&
    value.port <= 65535 &&
    typeof value.token === "string" &&
    value.token.length > 0 &&
    typeof value.startedAt === "string"
  );
}

export async function readVerifiedSupervisorState(
  projectRoot: string
): Promise<SupervisorStateFile | null> {
  const state = readSupervisorState(projectRoot);
  if (!state) {
    return null;
  }

  const { response, transportFailed } = await sendControlCommandToState(state, { type: "identity" });
  if (transportFailed && isPidAlive(state.supervisorPid)) {
    const error = response.ok ? "No identity response." : response.error;
    throw new Error(`Unable to verify prwr supervisor (pid ${state.supervisorPid}): ${error} Existing state has been preserved.`);
  }
  if (!response.ok || !isSupervisorIdentity(response.data) || !identityMatchesState(response.data, state)) {
    removeSupervisorState(projectRoot);
    return null;
  }

  return state;
}

export async function sendControlCommand(
  projectRoot: string,
  command: ControlCommand
): Promise<ControlResponse> {
  const state = await readVerifiedSupervisorState(projectRoot);
  if (!state) {
    return { ok: false, error: "prwr supervisor is not running for this project." };
  }

  return (await sendControlCommandToState(state, command)).response;
}

async function sendControlCommandToState(
  state: SupervisorStateFile,
  command: ControlCommand
): Promise<ControlExchange> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: state.port });
    let response = "";
    let responseBytes = 0;
    let settled = false;

    const finish = (value: ControlResponse, transportFailed = false) => {
      if (!settled) {
        settled = true;
        socket.setTimeout(0);
        resolve({ response: value, transportFailed });
      }
    };

    socket.setEncoding("utf8");
    const timeoutMs = command.type === "start" || command.type === "restart"
      ? START_CONTROL_CLIENT_TIMEOUT_MS : DEFAULT_CONTROL_CLIENT_TIMEOUT_MS;
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      finish({ ok: false, error: "Timed out waiting for prwr supervisor response." }, true);
    });

    socket.on("connect", () => {
      socket.end(JSON.stringify({ token: state.token, command } satisfies ControlEnvelope));
    });

    socket.on("data", (chunk) => {
      responseBytes += Buffer.byteLength(chunk, "utf8");
      if (responseBytes > DEFAULT_MAX_CONTROL_RESPONSE_BYTES) {
        socket.destroy();
        finish({ ok: false, error: "Supervisor response is too large." });
        return;
      }

      response += chunk;
    });

    socket.on("end", () => {
      if (response.length === 0) {
        finish({ ok: false, error: "Supervisor closed the connection without a response." }, true);
        return;
      }
      try {
        const parsed: unknown = JSON.parse(response);
        finish(isControlResponse(parsed) ? parsed : { ok: false, error: "Supervisor returned an invalid response." });
      } catch {
        finish({ ok: false, error: "Supervisor returned an invalid response." });
      }
    });

    socket.on("error", (error) => {
      finish({ ok: false, error: `Unable to reach prwr supervisor: ${error.message}` }, true);
    });
  });
}

function isControlResponse(value: unknown): value is ControlResponse {
  return isRecord(value) && (
    (value.ok === true && "data" in value) ||
    (value.ok === false && typeof value.error === "string")
  );
}

function isSupervisorIdentity(value: unknown): value is SupervisorIdentity {
  return (
    isRecord(value) &&
    typeof value.supervisorPid === "number" &&
    Number.isInteger(value.supervisorPid) &&
    value.supervisorPid > 0 &&
    typeof value.projectRoot === "string" &&
    typeof value.configPath === "string" &&
    typeof value.startedAt === "string"
  );
}

function identityMatchesState(identity: SupervisorIdentity, state: SupervisorStateFile): boolean {
  return (
    identity.supervisorPid === state.supervisorPid &&
    identity.projectRoot === state.projectRoot &&
    identity.configPath === state.configPath &&
    identity.startedAt === state.startedAt
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
