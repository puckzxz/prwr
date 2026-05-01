import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { isPidAlive } from "./kill-tree.js";
import { DEFAULT_MAX_CONTROL_RESPONSE_BYTES } from "./control-server.js";
import type {
  ControlCommand,
  ControlResponse,
  SupervisorIdentity,
  SupervisorStateFile
} from "./types.js";

const RUNTIME_DIR_NAME = ".prwr";
const STATE_FILE_NAME = "supervisor.json";
const DEFAULT_CONTROL_CLIENT_TIMEOUT_MS = 5000;

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

  let parsed: SupervisorStateFile;
  try {
    const raw = readFileSync(filePath, "utf8");
    parsed = JSON.parse(raw) as SupervisorStateFile;
  } catch {
    removeSupervisorState(projectRoot);
    return null;
  }

  if (!isValidState(parsed) || !isPidAlive(parsed.supervisorPid)) {
    removeSupervisorState(projectRoot);
    return null;
  }

  return parsed;
}

function isValidState(value: SupervisorStateFile): boolean {
  return (
    typeof value.supervisorPid === "number" &&
    Number.isInteger(value.supervisorPid) &&
    value.supervisorPid > 0 &&
    typeof value.projectRoot === "string" &&
    typeof value.configPath === "string" &&
    typeof value.port === "number" &&
    Number.isInteger(value.port) &&
    value.port > 0 &&
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

  const response = await sendControlCommandToState(projectRoot, state, { type: "identity" }, false);
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

  return sendControlCommandToState(projectRoot, state, command, true);
}

async function sendControlCommandToState(
  projectRoot: string,
  state: SupervisorStateFile,
  command: ControlCommand,
  removeStateOnFailure: boolean
): Promise<ControlResponse> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: state.port });
    let response = "";
    let responseBytes = 0;
    let settled = false;

    const finish = (value: ControlResponse, removeState = false) => {
      if (!settled) {
        settled = true;
        socket.setTimeout(0);
        if (removeState && removeStateOnFailure) {
          removeSupervisorState(projectRoot);
        }
        resolve(value);
      }
    };

    socket.setEncoding("utf8");
    socket.setTimeout(DEFAULT_CONTROL_CLIENT_TIMEOUT_MS, () => {
      socket.destroy();
      finish({ ok: false, error: "Timed out waiting for prwr supervisor response." }, true);
    });

    socket.on("connect", () => {
      socket.end(JSON.stringify({ token: state.token, command }));
    });

    socket.on("data", (chunk) => {
      responseBytes += Buffer.byteLength(chunk, "utf8");
      if (responseBytes > DEFAULT_MAX_CONTROL_RESPONSE_BYTES) {
        socket.destroy();
        finish({ ok: false, error: "Supervisor response is too large." }, true);
        return;
      }

      response += chunk;
    });

    socket.on("end", () => {
      try {
        finish(JSON.parse(response) as ControlResponse);
      } catch {
        finish({ ok: false, error: "Supervisor returned an invalid response." }, true);
      }
    });

    socket.on("error", (error) => {
      finish({ ok: false, error: `Unable to reach prwr supervisor: ${error.message}` }, true);
    });
  });
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
