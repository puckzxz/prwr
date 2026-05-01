import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ControlServer } from "../src/control-server.js";
import {
  readSupervisorState,
  readVerifiedSupervisorState,
  sendControlCommand,
  stateFilePath,
  writeSupervisorState
} from "../src/control-client.js";
import type { ControlCommand, ControlResponse, SupervisorIdentity, SupervisorStateFile } from "../src/types.js";

describe("control client state", () => {
  it("removes stale supervisor state files", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "prwr-state-"));
    mkdirSync(path.join(dir, ".prwr"), { recursive: true });
    writeFileSync(
      stateFilePath(dir),
      JSON.stringify({
        supervisorPid: 99999999,
        projectRoot: dir,
        configPath: path.join(dir, ".prwr.yml"),
        port: 1234,
        token: "token",
        startedAt: new Date().toISOString()
      })
    );

    expect(readSupervisorState(dir)).toBeNull();
    expect(readSupervisorState(dir)).toBeNull();
  });

  it("removes invalid supervisor state files", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "prwr-state-"));
    mkdirSync(path.join(dir, ".prwr"), { recursive: true });
    writeFileSync(stateFilePath(dir), "{not-json");

    expect(readSupervisorState(dir)).toBeNull();
    expect(existsSync(stateFilePath(dir))).toBe(false);
  });

  it("sends authenticated control commands through verified supervisor state", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "prwr-state-"));
    const state = stateFor(dir, 0, "token");
    const server = new ControlServer((command) => {
      if (command.type === "identity") {
        return identityFor(state);
      }

      return { message: `handled ${command.type}` };
    }, { token: "token" });
    const port = await server.listen();
    state.port = port;
    writeSupervisorState(state);

    try {
      await expect(sendControlCommand(dir, { type: "status" })).resolves.toEqual({
        ok: true,
        data: { message: "handled status" }
      });
    } finally {
      await server.close();
    }
  });

  it("removes state when identity probing fails authentication", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "prwr-state-"));
    const state = stateFor(dir, 0, "wrong-token");
    const server = new ControlServer(() => identityFor(state), { token: "actual-token" });
    const port = await server.listen();
    state.port = port;
    writeSupervisorState(state);

    try {
      await expect(readVerifiedSupervisorState(dir)).resolves.toBeNull();
      expect(existsSync(stateFilePath(dir))).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("rejects unauthorized control envelopes", async () => {
    const server = new ControlServer(() => ({ message: "ok" }), { token: "good-token" });
    const port = await server.listen();

    try {
      await expect(sendEnvelope(port, "bad-token", { type: "status" })).resolves.toMatchObject({
        ok: false,
        error: "Unauthorized control command."
      });
    } finally {
      await server.close();
    }
  });

  it("rejects malformed and oversized control payloads", async () => {
    const server = new ControlServer(() => ({ message: "ok" }), {
      token: "token",
      maxRequestBytes: 8
    });
    const port = await server.listen();

    try {
      await expect(sendRaw(port, "{not-json")).resolves.toMatchObject({
        ok: false,
        error: "Control request is too large."
      });
    } finally {
      await server.close();
    }

    const otherServer = new ControlServer(() => ({ message: "ok" }), { token: "token" });
    const otherPort = await otherServer.listen();
    try {
      await expect(sendRaw(otherPort, "{not-json")).resolves.toMatchObject({
        ok: false,
        error: "Invalid JSON command."
      });
    } finally {
      await otherServer.close();
    }
  });

  it("returns errors for request timeouts and oversized responses", async () => {
    const timeoutServer = new ControlServer(() => ({ message: "ok" }), {
      token: "token",
      requestTimeoutMs: 10
    });
    const timeoutPort = await timeoutServer.listen();

    try {
      await expect(readWithoutEnding(timeoutPort)).resolves.toMatchObject({
        ok: false,
        error: "Control request timed out."
      });
    } finally {
      await timeoutServer.close();
    }

    const responseServer = new ControlServer(() => ({ value: "x".repeat(200) }), {
      token: "token",
      maxResponseBytes: 64
    });
    const responsePort = await responseServer.listen();

    try {
      await expect(sendEnvelope(responsePort, "token", { type: "status" })).resolves.toMatchObject({
        ok: false,
        error: "Control response is too large."
      });
    } finally {
      await responseServer.close();
    }
  });
});

function stateFor(dir: string, port: number, token: string): SupervisorStateFile {
  return {
    supervisorPid: process.pid,
    projectRoot: dir,
    configPath: path.join(dir, ".prwr.yml"),
    port,
    token,
    startedAt: new Date().toISOString()
  };
}

function identityFor(state: SupervisorStateFile): SupervisorIdentity {
  return {
    supervisorPid: state.supervisorPid,
    projectRoot: state.projectRoot,
    configPath: state.configPath,
    startedAt: state.startedAt
  };
}

async function sendEnvelope(
  port: number,
  token: string,
  command: ControlCommand
): Promise<ControlResponse> {
  return sendRaw(port, JSON.stringify({ token, command }));
}

async function sendRaw(port: number, payload: string): Promise<ControlResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let response = "";

    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.end(payload);
    });
    socket.on("data", (chunk) => {
      response += chunk;
    });
    socket.on("end", () => {
      resolve(JSON.parse(response) as ControlResponse);
    });
    socket.on("error", reject);
  });
}

async function readWithoutEnding(port: number): Promise<ControlResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let response = "";

    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      response += chunk;
    });
    socket.on("end", () => {
      resolve(JSON.parse(response) as ControlResponse);
    });
    socket.on("error", reject);
  });
}
