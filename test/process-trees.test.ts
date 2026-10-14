import { describe, expect, it } from "vitest";
import { isPidAlive } from "../src/kill-tree.js";
import { managerFor, nodeCommand, processConfig, waitFor } from "./helpers/process-manager.js";

function treeCommand(): string {
  return nodeCommand(
    "const { spawn } = require('node:child_process'); " +
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); " +
    "console.log('grandchild=' + child.pid); " +
    "setInterval(() => {}, 1000);"
  );
}

function grandchildPids(output: string): number[] {
  return [...output.matchAll(/grandchild=(\d+)/g)].map((match) => Number(match[1]));
}

describe("process tree lifecycle", () => {
  it("stops child process trees so node grandchildren are not left running", async () => {
    const { manager, stdout } = managerFor([processConfig({ command: treeCommand() })]);

    try {
      await manager.start("api");
      await waitFor(() => grandchildPids(stdout.value).length === 1);
      const grandchildPid = grandchildPids(stdout.value)[0]!;

      await manager.stop("api");
      await waitFor(() => !isPidAlive(grandchildPid));

      expect(manager.getStatus()[0]?.state).toBe("stopped");
      expect(isPidAlive(grandchildPid)).toBe(false);
    } finally {
      await manager.stopAll();
    }
  });

  it("kills the old tree before restart and cleans up the replacement on repeated shutdown", async () => {
    const { manager, stdout } = managerFor([processConfig({ command: treeCommand() })]);

    try {
      const original = await manager.start("api");
      await waitFor(() => grandchildPids(stdout.value).length === 1);
      const oldGrandchild = grandchildPids(stdout.value)[0]!;

      const replacement = await manager.restart("api");
      expect(isPidAlive(original.pid!)).toBe(false);
      expect(isPidAlive(oldGrandchild)).toBe(false);
      expect(replacement.pid).not.toBe(original.pid);
      await waitFor(() => grandchildPids(stdout.value).length === 2);
      const newGrandchild = grandchildPids(stdout.value)[1]!;

      expect(await Promise.all([manager.stopAll(), manager.stopAll()])).toEqual([true, true]);
      await waitFor(() => !isPidAlive(newGrandchild));
      expect(isPidAlive(replacement.pid!)).toBe(false);
      expect(manager.getStatus()[0]?.state).toBe("stopped");
    } finally {
      await manager.stopAll();
    }
  });
});
