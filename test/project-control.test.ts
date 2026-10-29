import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { stateFilePath, writeSupervisorState } from "../src/control-client.js";
import { ControlServer } from "../src/control-server.js";
import { waitForProcesses } from "../src/process-wait.js";
import { sendProjectCommand } from "../src/supervisor.js";
import type { ControlCommand, ControlEnvelope } from "../src/types.js";
import { CliTestHarness, within } from "./helpers/cli-process.js";
import { identityFor, stateFor, statusFor } from "./helpers/control.js";
import { close, listen, trackConnections, waitForRealTime } from "./helpers/readiness.js";

describe("targeted project control", () => {
  it("resolves config paths from the caller without reloading config or env files", async () => {
    const harness = new CliTestHarness();
    const project = path.join(harness.root, "project with spaces");
    mkdirSync(project);
    const state = stateFor(project, 0, "fixture-token");
    const commands: ControlCommand[] = [];
    const server = new ControlServer((command) => {
      if (command.type === "identity") return identityFor(state);
      commands.push(command);
      return statusFor(undefined, { ...identityFor(state), port: state.port });
    }, { token: state.token });
    state.port = await server.listen();
    writeSupervisorState(state);
    // Control must remain usable even after the selected config becomes invalid.
    writeFileSync(state.configPath, "processes: [invalid config\nenvFile: missing.env");
    try {
      const relative = path.relative(harness.root, state.configPath);
      await expect(sendProjectCommand(harness.root, { type: "status" }, { configPath: relative })).resolves.toMatchObject({ ok: true });
      await expect(sendProjectCommand(harness.root, { type: "status" }, { configPath: state.configPath })).resolves.toMatchObject({ ok: true });
      if (process.platform === "win32") {
        await expect(sendProjectCommand(harness.root, { type: "status" }, { configPath: state.configPath.toUpperCase() }))
          .resolves.toMatchObject({ ok: true });
      }
      const before = readFileSync(stateFilePath(project), "utf8");
      await expect(sendProjectCommand(harness.root, { type: "down" }, { configPath: path.join(project, "other.yml") }))
        .rejects.toThrow(/different config/);
      expect(readFileSync(stateFilePath(project), "utf8")).toBe(before);
      expect(commands.every(({ type }) => type === "status")).toBe(true);
      expect(commands).toHaveLength(process.platform === "win32" ? 3 : 2);
    } finally {
      await server.close();
      await harness.cleanup();
    }
  });

  it.each(["identity", "status"] as const)("cancels a stalled %s exchange without deleting live state", async (stalledCommand) => {
    const harness = new CliTestHarness();
    const state = stateFor(harness.root, 0, "fixture-token");
    let received: () => void = () => undefined;
    const stalled = new Promise<void>((resolve) => { received = resolve; });
    const server = net.createServer({ allowHalfOpen: true }, (socket) => {
      let payload = "";
      socket.on("data", (chunk: Buffer) => { payload += chunk.toString("utf8"); });
      socket.on("error", () => socket.destroy());
      socket.on("end", () => {
        const { command } = JSON.parse(payload) as ControlEnvelope;
        if (command.type === stalledCommand) received();
        else socket.end(JSON.stringify({ ok: true, data: identityFor(state) }));
      });
    });
    const sockets = trackConnections(server);
    state.port = await listen(server);
    writeSupervisorState(state);
    const controller = new AbortController();
    const connections = vi.spyOn(net, "createConnection");
    try {
      const pending = sendProjectCommand(harness.root, { type: "status" }, { signal: controller.signal });
      const rejected = expect(pending).rejects.toThrow("cancelled request");
      await within(stalled, 1500, "Control exchange did not start.");
      controller.abort(new Error("cancelled request"));
      await rejected;
      const clients = connections.mock.results.map((result) => result.value as net.Socket);
      expect(clients).toHaveLength(stalledCommand === "identity" ? 1 : 2);
      await waitForRealTime(() => clients.every((socket) => socket.closed));
      expect(JSON.parse(readFileSync(stateFilePath(harness.root), "utf8"))).toEqual(state);
    } finally {
      controller.abort();
      connections.mockRestore();
      await close(server, sockets);
      await harness.cleanup();
    }
  });

  it("enforces the wait deadline while identity verification is stalled", async () => {
    const harness = new CliTestHarness();
    const server = net.createServer({ allowHalfOpen: true }, (socket) => {
      socket.resume();
      socket.on("error", () => socket.destroy());
    });
    const sockets = trackConnections(server);
    const state = stateFor(harness.root, await listen(server), "fixture-token");
    writeSupervisorState(state);
    const connections = vi.spyOn(net, "createConnection");
    try {
      await within(expect(waitForProcesses(harness.root, { names: [], timeoutMs: 50 })).rejects.toThrow(/Timed out after 50ms/),
        1500, "Wait exceeded its deadline during identity verification.");
      const clients = connections.mock.results.map((result) => result.value as net.Socket);
      expect(clients).toHaveLength(1);
      await waitForRealTime(() => clients.every((socket) => socket.closed));
      expect(existsSync(stateFilePath(harness.root))).toBe(true);
    } finally {
      connections.mockRestore();
      await close(server, sockets);
      await harness.cleanup();
    }
  });
});
