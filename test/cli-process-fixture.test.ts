import { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { killTree } from "../src/kill-tree.js";
import { CliTestHarness } from "./helpers/cli-process.js";
import { fakeChild } from "./helpers/process-manager.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(), spawn: vi.fn()
}));
vi.mock("../src/kill-tree.js", () => ({
  // Simulate a finished PID having been reassigned to an unrelated live process.
  isPidAlive: vi.fn(() => true), isProcessGroupAlive: vi.fn(() => true), killTree: vi.fn(async () => undefined)
}));

describe("CLI fixture process ownership", () => {
  afterEach(() => { vi.clearAllMocks(); });

  it("retires completed Windows CLI PIDs while retaining POSIX process groups", async () => {
    const child = fakeChild(12345);
    vi.mocked(spawn).mockReturnValue(child);
    const harness = new CliTestHarness();
    const running = harness.start(harness.root, ["status"]);
    child.emit("close", 0, null);
    await running.completion;
    await harness.cleanup();
    if (process.platform === "win32") expect(killTree).not.toHaveBeenCalled();
    else expect(killTree).toHaveBeenCalledExactlyOnceWith(child.pid);
  });

  it("still kills a running CLI tree and waits for it to close", async () => {
    const child = fakeChild(12346);
    vi.mocked(spawn).mockReturnValue(child);
    vi.mocked(killTree).mockImplementation(async () => { child.emit("close", null, "SIGTERM"); });
    const harness = new CliTestHarness();
    const running = harness.start(harness.root, ["up"]);
    await harness.cleanup();
    expect(killTree).toHaveBeenCalledExactlyOnceWith(child.pid);
    expect(running.closed).toBe(true);
    await expect(running.completion).resolves.toMatchObject({ code: null, signal: "SIGTERM" });
  });

  it("does not kill reassigned PIDs after their fixture processes were confirmed stopped", async () => {
    const harness = new CliTestHarness();
    harness.trackTree(12347);
    harness.trackDescendant(12347);
    harness.forgetPid(12347);
    await harness.cleanup();
    expect(killTree).not.toHaveBeenCalled();
  });
});
