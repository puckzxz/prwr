import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runCheck } from "../src/supervisor.js";

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "prwr-supervisor-"));
}

describe("runCheck", () => {
  it("validates config and reports supervisor state without starting processes", async () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, ".prwr.yml"), "processes:\n  web:\n    command: npm start\n");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      await expect(runCheck({ cwd: dir })).resolves.toBe(0);
      expect(log).toHaveBeenCalledWith(expect.stringContaining("prwr config ok:"));
      expect(log).toHaveBeenCalledWith("prwr supervisor not running");
    } finally {
      log.mockRestore();
    }
  });

  it("rejects missing resolved process working directories", async () => {
    const dir = tempDir();
    writeFileSync(
      path.join(dir, ".prwr.yml"),
      "processes:\n  web:\n    command: npm start\n    cwd: ./missing\n"
    );

    await expect(runCheck({ cwd: dir })).rejects.toThrow(/cwd does not exist/);
  });
});
