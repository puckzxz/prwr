import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isPidAlive, isProcessGroupAlive, killTree } from "../../src/kill-tree.js";

const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
const sourceCli = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));

export interface CliResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface RunningCli {
  child: ChildProcess;
  readonly stdout: string;
  readonly stderr: string;
  readonly closed: boolean;
  completion: Promise<CliResult>;
}

export class CliTestHarness {
  readonly root = mkdtempSync(path.join(tmpdir(), "prwr-cli-"));
  private readonly running = new Set<RunningCli>();
  private readonly processTrees = new Set<number>();
  private readonly descendants = new Set<number>();

  constructor(private readonly env: NodeJS.ProcessEnv = {}) {}

  start(cwd: string, args: string[]): RunningCli {
    const child = spawn(process.execPath, [tsxCli, sourceCli, ...args], {
      cwd, env: { ...process.env, ...this.env }, stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32", windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    let closed = false;
    child.stdout!.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr!.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    const completion = new Promise<CliResult>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        closed = true;
        resolve({ code, signal, stdout, stderr });
      });
    });
    const running: RunningCli = {
      child, get stdout() { return stdout; }, get stderr() { return stderr; },
      get closed() { return closed; }, completion
    };
    this.running.add(running);
    if (child.pid) this.processTrees.add(child.pid);
    return running;
  }

  async run(cwd: string, args: string[], timeoutMs = 10000): Promise<CliResult> {
    const running = this.start(cwd, args);
    return within(running.completion, timeoutMs, `CLI ${args[0] ?? "up"} did not finish.`);
  }

  trackTree(pid: number | null): void {
    if (pid !== null && pid > 0) this.processTrees.add(pid);
  }

  trackDescendant(pid: number): void {
    if (pid > 0) this.descendants.add(pid);
  }

  async cleanup(): Promise<void> {
    for (const pid of this.processTrees) {
      const alive = process.platform === "win32" ? isPidAlive(pid) : isProcessGroupAlive(pid);
      if (alive) await killTree(pid);
    }
    // Descendants come only from this fixture's PID file; also clean up if a failed supervisor orphaned one.
    for (const pid of this.descendants) {
      if (isPidAlive(pid)) {
        if (process.platform === "win32") await killTree(pid);
        else process.kill(pid, "SIGKILL");
      }
    }
    for (const running of this.running) {
      if (!running.closed) await within(running.completion, 5000, "Test CLI did not close during cleanup.");
    }
    const relative = path.relative(path.resolve(tmpdir()), path.resolve(this.root));
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Refusing to remove a fixture outside the temporary directory: ${this.root}`);
    }
    rmSync(this.root, { recursive: true, force: true });
  }
}

export async function within<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
