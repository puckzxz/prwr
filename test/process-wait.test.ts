import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForProcesses } from "../src/process-wait.js";
import { SUPERVISOR_NOT_RUNNING } from "../src/control-client.js";
import { sendProjectCommand } from "../src/supervisor.js";
import { delay } from "../src/timing.js";
import { processStatusFor, statusFor } from "./helpers/control.js";

vi.mock("../src/supervisor.js", () => ({ sendProjectCommand: vi.fn() }));
vi.mock("../src/timing.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/timing.js")>(), delay: vi.fn()
}));

const request = vi.mocked(sendProjectCommand);

describe("waiting for startup state", () => {
  afterEach(() => { vi.resetAllMocks(); vi.useRealTimers(); });

  it("returns immediately when every selected process is running", async () => {
    const status = statusFor([processStatusFor("api"), processStatusFor("web", { state: "stopped", pid: null })]);
    request.mockResolvedValue({ ok: true, data: status });
    await expect(waitForProcesses("project", { names: ["api"], timeoutMs: 1000, configPath: "app.yml" })).resolves.toBe(status);
    expect(request).toHaveBeenCalledWith("project", { type: "status" }, { configPath: "app.yml", signal: expect.any(AbortSignal) });
    expect(delay).not.toHaveBeenCalled();
  });

  it("waits for the supervisor to appear, then for all its selected processes", async () => {
    const ready = statusFor([processStatusFor("api"), processStatusFor("web")]);
    request.mockResolvedValueOnce({ ok: false, error: SUPERVISOR_NOT_RUNNING })
      .mockResolvedValueOnce({ ok: true, data: statusFor([processStatusFor("api", { state: "starting" }), processStatusFor("web", { state: "stopped", pid: null })]) })
      .mockResolvedValueOnce({ ok: true, data: statusFor([processStatusFor("api", { state: "restarting" }), processStatusFor("web")]) })
      .mockResolvedValueOnce({ ok: true, data: ready });
    await expect(waitForProcesses("project", { names: [], timeoutMs: 1000 })).resolves.toBe(ready);
    expect(delay).toHaveBeenCalledTimes(3);
    expect(request.mock.calls.every(([, command]) => command.type === "status")).toBe(true);
  });

  it.each(["missing", "failed"])("fails immediately for %s processes", async (kind) => {
    request.mockResolvedValue({ ok: true, data: statusFor([processStatusFor("api", { state: "failed", lastError: "Readiness timed out." })]) });
    await expect(waitForProcesses("project", { names: [kind === "missing" ? "web" : "api"], timeoutMs: 1000 }))
      .rejects.toThrow(kind === "missing" ? /Unknown process "web". Available processes: api/ : /Process "api" failed: Readiness timed out/);
    expect(delay).not.toHaveBeenCalled();
  });

  it("reports a transport failure without retrying a live supervisor", async () => {
    request.mockRejectedValue(new Error("Unable to verify supervisor. Existing state has been preserved."));
    await expect(waitForProcesses("project", { names: [], timeoutMs: 1000 })).rejects.toThrow(/state has been preserved/);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each(["stopped", "replaced"])("rejects a %s supervisor after observing it", async (kind) => {
    const starting = statusFor([processStatusFor("api", { state: "starting" })]);
    request.mockResolvedValueOnce({ ok: true, data: starting }).mockResolvedValueOnce(kind === "stopped"
      ? { ok: false, error: SUPERVISOR_NOT_RUNNING }
      : { ok: true, data: statusFor(undefined, { startedAt: "2026-10-29T13:00:00.000Z" }) });
    await expect(waitForProcesses("project", { names: [], timeoutMs: 1000 })).rejects.toThrow(`supervisor ${kind === "stopped" ? "stopped" : "changed"}`);
  });

  it.each([null, {}, { processes: [] }, { ...statusFor(), processes: [processStatusFor("api", { state: "unknown" as never })] }])
    ("rejects malformed status %j", async (data) => {
      request.mockResolvedValue({ ok: true, data });
      await expect(waitForProcesses("project", { names: [], timeoutMs: 1000 })).rejects.toThrow(/invalid status response/);
    });

  it("bounds the entire request and releases its deadline timer", async () => {
    vi.useFakeTimers();
    request.mockImplementation((_cwd, _command, options) => new Promise((_resolve, reject) => {
      options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), { once: true });
    }));
    const waiting = waitForProcesses("project", { names: [], timeoutMs: 50 });
    const rejected = expect(waiting).rejects.toThrow("Timed out after 50ms waiting for prwr supervisor.");
    await vi.advanceTimersByTimeAsync(50);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports the last pending states on timeout", async () => {
    vi.useFakeTimers();
    request.mockResolvedValue({ ok: true, data: statusFor([processStatusFor("api", { state: "starting" })]) });
    vi.mocked(delay).mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 100)));
    const waiting = waitForProcesses("project", { names: [], timeoutMs: 50 });
    const rejected = expect(waiting).rejects.toThrow("Timed out after 50ms waiting for api (starting).");
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts an in-flight request and removes the external signal listener", async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    request.mockImplementation((_cwd, _command, options) => new Promise((_resolve, reject) => {
      options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), { once: true });
    }));
    const waiting = waitForProcesses("project", { names: [], timeoutMs: 1000, signal: controller.signal });
    controller.abort(new Error("interrupted"));
    await expect(waiting).rejects.toThrow("interrupted");
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not contact the supervisor for invalid timeouts or an already cancelled wait", async () => {
    await expect(waitForProcesses("project", { names: [], timeoutMs: 0 })).rejects.toThrow(/Wait timeout/);
    await expect(waitForProcesses("project", { names: [], timeoutMs: 1000, signal: AbortSignal.abort(new Error("cancelled")) }))
      .rejects.toThrow("cancelled");
    expect(request).not.toHaveBeenCalled();
  });
});
