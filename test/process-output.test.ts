import { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { fakeChild, managerFor, nodeCommand, processConfig, waitFor } from "./helpers/process-manager.js";

describe("process output lifecycle", () => {
  it("flushes final partial stdout and stderr from a real child", async () => {
    const process = processConfig({
      command: nodeCommand("process.stdout.write('out-partial'); process.stderr.write('err-partial')")
    });
    const { manager, stdout, stderr } = managerFor([process]);

    try {
      await manager.start("api");
      await waitFor(() => manager.getStatus()[0]?.state === "stopped");

      expect(stdout.value).toContain("api | out-partial\n");
      expect(stderr.value).toContain("api | err-partial\n");
    } finally {
      await manager.stopAll();
    }
  });

  it("drains output arriving after exit before flushing final lines", async () => {
    const child = fakeChild(9700);
    const { manager, stdout, stderr } = managerFor([processConfig()], {
      spawnProcess: (() => child) as typeof spawn
    });

    await manager.start("api");
    child.stdout?.emit("data", Buffer.from("out-"));
    child.stderr?.emit("data", Buffer.from("err-"));
    child.emit("exit", 0, null);
    child.stdout?.emit("data", Buffer.from("final"));
    child.stderr?.emit("data", Buffer.from("final"));
    child.emit("close", 0, null);

    expect(stdout.value).toContain("api | out-final\n");
    expect(stderr.value).toContain("api | err-final\n");
    expect(stdout.value.indexOf("out-final")).toBeLessThan(stdout.value.indexOf("stopped exitCode=0"));
    expect(manager.getStatus()[0]).toMatchObject({ state: "stopped", lastExitCode: 0 });
  });

  it("defers automatic restart until the old child's output closes", async () => {
    vi.useFakeTimers();
    try {
      const spawnProcess = vi.fn(() => fakeChild(9800));
      const { manager } = managerFor([processConfig({ restart: "always", restartBackoffMs: 1 })], {
        spawnProcess: spawnProcess as unknown as typeof spawn
      });

      await manager.start("api");
      const child = spawnProcess.mock.results[0]!.value;
      child.emit("exit", 1, null);
      await vi.advanceTimersByTimeAsync(1);
      expect(spawnProcess).toHaveBeenCalledTimes(1);

      child.emit("close", 1, null);
      await vi.advanceTimersByTimeAsync(1);
      expect(spawnProcess).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
