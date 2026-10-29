import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { colorForName } from "../src/logger.js";
import { runCheck, runUp, sendProjectCommand } from "../src/supervisor.js";
import type { ProcessStatus, SupervisorStatus } from "../src/types.js";

vi.mock("../src/supervisor.js", () => ({ runCheck: vi.fn(), runUp: vi.fn(), sendProjectCommand: vi.fn() }));

const processStatus: ProcessStatus = {
  name: "web", state: "running", pid: 101, command: "node web.js", cwd: "C:/project",
  lastExitCode: null, lastSignal: null, restartCount: 2, lastError: null
};
const status: SupervisorStatus = {
  supervisor: { supervisorPid: 100, projectRoot: "C:/project", configPath: "C:/project/.prwr.yml", port: 9000, startedAt: "2026-10-14T12:34:56.000Z" },
  processes: [processStatus]
};

describe("CLI feature execution", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("writes one JSON status document containing public fields only", async () => {
    vi.mocked(sendProjectCommand).mockResolvedValue({
      ok: true,
      data: {
        ...status,
        supervisor: { ...status.supervisor, token: "private-token" },
        processes: [{ ...processStatus, env: { SECRET: "private-environment" }, config: { env: { SECRET: "secret" } } }]
      }
    });
    await expect(main(["status", "--json"])).resolves.toBe(0);
    expect(sendProjectCommand).toHaveBeenCalledWith(process.cwd(), { type: "status" });
    expect(console.log).toHaveBeenCalledTimes(1);
    const output = vi.mocked(console.log).mock.calls[0]![0] as string;
    expect(JSON.parse(output)).toEqual(status);
    expect(output).not.toContain("private-");
    expect(console.error).not.toHaveBeenCalled();
  });

  it("keeps human status output available", async () => {
    vi.mocked(sendProjectCommand).mockResolvedValue({ ok: true, data: status });
    await expect(main(["status"])).resolves.toBe(0);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("Supervisor pid=100"));
    expect(console.log).toHaveBeenCalledWith(expect.stringMatching(/web\s+running\s+101\s+2\s+-\s+node web.js/));
  });

  it("writes JSON failures to stdout with a failing exit code", async () => {
    vi.mocked(sendProjectCommand).mockResolvedValue({ ok: false, error: "prwr supervisor is not running for this project." });
    await expect(main(["status", "--json"])).resolves.toBe(1);
    expect(console.log).toHaveBeenCalledWith(JSON.stringify({ ok: false, error: "prwr supervisor is not running for this project." }));
    expect(console.error).not.toHaveBeenCalled();
  });

  it("reports invalid JSON status arguments without contacting the supervisor", async () => {
    await expect(main(["status", "--json", "--unknown"])).resolves.toBe(1);
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0]![0] as string)).toEqual({
      ok: false, error: 'Command "status" does not accept arguments.'
    });
    expect(sendProjectCommand).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("keeps thrown JSON status errors machine readable", async () => {
    vi.mocked(sendProjectCommand).mockRejectedValue(new Error("Unable to read supervisor state."));
    await expect(main(["status", "--json"])).resolves.toBe(1);
    expect(console.log).toHaveBeenCalledWith(JSON.stringify({ ok: false, error: "Unable to read supervisor state." }));
    expect(console.error).not.toHaveBeenCalled();
  });

  it.each(["up", "check"])("forwards %s selectors to the shared process selection", async (command) => {
    vi.mocked(runUp).mockResolvedValue(0);
    vi.mocked(runCheck).mockResolvedValue(0);
    await expect(main([command, "--only", "web,api", "--exclude", "worker", "--config", "project/.prwr.yml"]))
      .resolves.toBe(0);
    expect(command === "up" ? runUp : runCheck).toHaveBeenCalledWith(expect.objectContaining({
      cwd: process.cwd(), only: ["web", "api"], exclude: ["worker"], configPath: "project/.prwr.yml"
    }));
  });

  it("replays history using original timestamps and streams without modifying entries", async () => {
    const entries = [
      { name: "web", stream: "stdout", kind: "output", timestamp: "2026-10-14T12:34:56.000Z", text: " hello 🌱" },
      { name: "web", stream: "stderr", kind: "output", timestamp: "2026-10-14T12:34:57.000Z", text: "last partial" }
    ];
    const original = structuredClone(entries);
    vi.mocked(sendProjectCommand).mockResolvedValue({ ok: true, data: { name: "web", entries } });
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await expect(main(["logs", "web", "--tail", "2", "--no-color"])).resolves.toBe(0);
    expect(sendProjectCommand).toHaveBeenCalledWith(process.cwd(), { type: "logs", name: "web", tail: 2 });
    expect(stdout).toHaveBeenCalledWith("2026-10-14T12:34:56.000Z web |  hello 🌱\n");
    expect(stderr).toHaveBeenCalledWith("2026-10-14T12:34:57.000Z web | last partial\n");
    expect(entries).toEqual(original);
    expect(console.log).not.toHaveBeenCalled();
  });

  it("returns success for an empty log history", async () => {
    vi.mocked(sendProjectCommand).mockResolvedValue({ ok: true, data: { name: "web", entries: [] } });
    await expect(main(["logs", "web", "--tail", "0"])).resolves.toBe(0);
    expect(console.log).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("uses the live logger's label colors for replay and honors NO_COLOR", async () => {
    vi.stubEnv("NO_COLOR", "");
    vi.mocked(sendProjectCommand).mockResolvedValue({
      ok: true, data: { name: "web", entries: [{ name: "web", stream: "stdout", kind: "output", timestamp: "2026-10-14T12:34:56.000Z", text: "hello" }] }
    });
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await expect(main(["logs", "web", "--color"])).resolves.toBe(0);
    expect(stdout).toHaveBeenLastCalledWith(`2026-10-14T12:34:56.000Z ${colorForName("web", "web | ")}hello\n`);
    vi.stubEnv("NO_COLOR", "1");
    await expect(main(["logs", "web", "--color"])).resolves.toBe(0);
    expect(stdout).toHaveBeenLastCalledWith("2026-10-14T12:34:56.000Z web | hello\n");
  });

  it.each(["start", "restart", "stop"])("returns useful process failures for %s", async (command) => {
    vi.mocked(sendProjectCommand).mockResolvedValue({
      ok: true, data: { ...processStatus, state: "failed", pid: null, lastError: "Readiness check timed out." }
    });
    await expect(main([command, "web"])).resolves.toBe(1);
    expect(console.error).toHaveBeenCalledWith(`Failed to ${command} "web": Readiness check timed out.`);
  });

  it.each([
    { args: ["status", "--json"], command: { type: "status" }, data: status },
    { args: ["down"], command: { type: "down" }, data: { message: "stopping" } },
    { args: ["start", "web"], command: { type: "start", name: "web" }, data: processStatus },
    { args: ["stop", "web"], command: { type: "stop", name: "web" }, data: processStatus },
    { args: ["restart", "web"], command: { type: "restart", name: "web" }, data: processStatus },
    { args: ["send", "web", "rs"], command: { type: "send", name: "web", text: "rs" }, data: {} },
    { args: ["logs", "web", "--tail", "0"], command: { type: "logs", name: "web", tail: 0 }, data: { name: "web", entries: [] } }
  ])("forwards config targeting for $command.type", async ({ args, command, data }) => {
    vi.mocked(sendProjectCommand).mockResolvedValue({ ok: true, data });
    await expect(main(["--config", "../app/.prwr.yml", ...args])).resolves.toBe(0);
    expect(sendProjectCommand).toHaveBeenCalledWith(process.cwd(), command, { configPath: "../app/.prwr.yml" });
  });

  it.each(["status", "wait"])("keeps malformed global options machine readable for %s", async (command) => {
    await expect(main(["--config=", command, "--json"])).resolves.toBe(1);
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0]![0] as string)).toEqual({
      ok: false, error: "Option --config requires a nonempty path."
    });
    expect(sendProjectCommand).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it.each([false, true])("prints readiness success with JSON mode %s", async (json) => {
    const sigint = process.listenerCount("SIGINT");
    const sigterm = process.listenerCount("SIGTERM");
    vi.mocked(sendProjectCommand).mockResolvedValue({ ok: true, data: {
      ...status, supervisor: { ...status.supervisor, token: "private-token" },
      processes: [{ ...processStatus, env: { SECRET: "private-environment" } }]
    } });
    await expect(main(["wait", "web", "--config", "app.yml", ...(json ? ["--json"] : [])])).resolves.toBe(0);
    expect(console.log).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledWith(json ? JSON.stringify(status) : "prwr ready: web");
    expect(sendProjectCommand).toHaveBeenCalledWith(process.cwd(), { type: "status" }, {
      configPath: "app.yml", signal: expect.any(AbortSignal)
    });
    expect(process.listenerCount("SIGINT")).toBe(sigint);
    expect(process.listenerCount("SIGTERM")).toBe(sigterm);
  });

  it("prints one JSON wait failure without environment or token fields", async () => {
    vi.mocked(sendProjectCommand).mockResolvedValue({ ok: true, data: { ...status, processes: [{ ...processStatus, state: "failed", lastError: "Readiness timed out." }] } });
    await expect(main(["wait", "web", "--json"])).resolves.toBe(1);
    expect(console.log).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ ok: false, error: 'Process "web" failed: Readiness timed out.' }));
    expect(console.error).not.toHaveBeenCalled();
  });

  it.each(["SIGINT", "SIGTERM"] as const)("cancels a wait on %s and removes its signal handlers", async (signal) => {
    const before = process.listenerCount(signal);
    vi.mocked(sendProjectCommand).mockImplementation((_cwd, _command, options) => new Promise((_resolve, reject) => {
      options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), { once: true });
    }));
    const waiting = main(["wait", "web", "--json"]);
    process.emit(signal);
    await expect(waiting).resolves.toBe(1);
    expect(console.log).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ ok: false, error: "prwr wait interrupted." }));
    expect(process.listenerCount(signal)).toBe(before);
    expect(sendProjectCommand).toHaveBeenCalledTimes(1);
  });
});
