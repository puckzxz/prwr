import { describe, expect, it } from "vitest";
import { isControlEnvelope, isSupervisorStatus, PUBLIC_CONTROL_COMMAND_TYPES, sameSupervisorIdentity } from "../src/control-protocol.js";
import { MAX_LOG_TAIL } from "../src/log-history.js";
import type { ControlCommand, ProcessRunState, SupervisorIdentity } from "../src/types.js";
import { processStatusFor, statusFor } from "./helpers/control.js";

describe("control protocol", () => {
  it.each([
    { type: "status" }, { type: "identity" }, { type: "down" },
    { type: "start", name: "api" }, { type: "stop", name: "api" }, { type: "restart", name: "api" },
    { type: "send", name: "api", text: "rs" },
    { type: "logs", name: "api", tail: 0 }, { type: "logs", name: "api", tail: MAX_LOG_TAIL }
  ] satisfies ControlCommand[])("accepts a supported command: %j", (command) => {
    expect(isControlEnvelope({ token: "token", command })).toBe(true);
  });

  it.each([
    null, [], "status", {}, { type: "missing" }, { type: "__proto__" }, { type: "constructor" },
    { type: "start" }, { type: "restart", name: 123 }, { type: "stop", name: "" },
    { type: "send", name: "api", text: null }, { type: "logs", name: "api" },
    { type: "logs", name: "api", tail: -1 }, { type: "logs", name: "api", tail: 1.5 },
    { type: "logs", name: "api", tail: MAX_LOG_TAIL + 1 }, { type: "logs", tail: 10 }
  ])("rejects malformed/unknown commands before dispatch: %j", (command) => {
    expect(isControlEnvelope({ token: "token", command })).toBe(false);
  });

  it.each([null, [], {}, { command: { type: "status" } }, { token: "", command: { type: "status" } }])(
    "rejects malformed envelopes: %j", (value) => {
      expect(isControlEnvelope(value)).toBe(false);
    }
  );

  it("derives public CLI command types from supported protocol commands", () => {
    expect(PUBLIC_CONTROL_COMMAND_TYPES).toContain("logs");
    expect(PUBLIC_CONTROL_COMMAND_TYPES).not.toContain("identity");
    for (const type of PUBLIC_CONTROL_COMMAND_TYPES) {
      const command = type === "logs" ? { type, name: "api", tail: 10 }
        : type === "send" ? { type, name: "api", text: "rs" } : { type, name: "api" };
      expect(isControlEnvelope({ token: "token", command })).toBe(true);
    }
  });
});

describe("status response contract", () => {
  const states = {
    starting: true, running: true, stopped: true, restarting: true, failed: true
  } satisfies Record<ProcessRunState, true>;

  it.each(Object.keys(states) as ProcessRunState[])("accepts the supported %s state", (state) => {
    expect(isSupervisorStatus(statusFor([processStatusFor("api", { state })]))).toBe(true);
  });

  it.each([
    { supervisorPid: process.pid + 1 }, { startedAt: "2026-10-29T13:00:00.000Z" },
    { projectRoot: "other-project" }, { configPath: "other.yml" }
  ] satisfies Partial<SupervisorIdentity>[])("rejects changed supervisor identity %j", (change) => {
    const original = statusFor().supervisor;
    expect(sameSupervisorIdentity(original, { ...original })).toBe(true);
    expect(sameSupervisorIdentity(original, { ...original, ...change })).toBe(false);
  });

  it.each([
    null, [], {}, { ...statusFor(), supervisor: {} }, { ...statusFor(), processes: [] },
    statusFor(undefined, { port: 0 }), statusFor(undefined, { port: 65536 }),
    statusFor([processStatusFor("api"), processStatusFor("api")]),
    ...[{ state: "unknown" }, { state: "constructor" }, { state: "__proto__" }, { pid: -1 },
      { restartCount: -1 }, { lastError: 1 }, { lastExitCode: "1" }].map((overrides) => ({
      ...statusFor(), processes: [{ ...processStatusFor("api"), ...overrides }]
    }))
  ])("rejects malformed or ambiguous status %j", (value) => {
    expect(isSupervisorStatus(value)).toBe(false);
  });
});
