import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readSupervisorState, stateFilePath } from "../src/control-client.js";

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
});
