import { describe, expect, it } from "vitest";
import { isProcessGroupAlive, killTree } from "../src/kill-tree.js";

describe("killTree", () => {
  it("polls and escalates against the POSIX process group", async () => {
    const calls: Array<{ pid: number; signal: string | number | undefined }> = [];
    const killProcess = ((pid: number, signal?: string | number) => {
      calls.push({ pid, signal });
      return true;
    }) as typeof process.kill;

    await killTree(1234, { platform: "linux", timeoutMs: 1, killProcess });

    expect(calls).toContainEqual({ pid: -1234, signal: "SIGTERM" });
    expect(calls).toContainEqual({ pid: -1234, signal: 0 });
    expect(calls).toContainEqual({ pid: -1234, signal: "SIGKILL" });
  });

  it("falls back to the leader pid if group signaling is unavailable", async () => {
    const calls: Array<{ pid: number; signal: string | number | undefined }> = [];
    const killProcess = ((pid: number, signal?: string | number) => {
      calls.push({ pid, signal });
      if (pid < 0) {
        const error = new Error("unsupported") as NodeJS.ErrnoException;
        error.code = "EINVAL";
        throw error;
      }

      return true;
    }) as typeof process.kill;

    await killTree(1234, { platform: "linux", timeoutMs: 1, killProcess });

    expect(calls).toContainEqual({ pid: 1234, signal: "SIGTERM" });
    expect(calls).toContainEqual({ pid: 1234, signal: "SIGKILL" });
  });

  it("treats missing process groups as not alive", () => {
    const killProcess = ((pid: number, signal?: string | number) => {
      if (pid < 0 && signal === 0) {
        const error = new Error("missing") as NodeJS.ErrnoException;
        error.code = "ESRCH";
        throw error;
      }

      return true;
    }) as typeof process.kill;

    expect(isProcessGroupAlive(1234, killProcess)).toBe(false);
  });
});
