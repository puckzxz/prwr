import { spawn } from "node:child_process";

export interface KillTreeOptions {
  platform?: NodeJS.Platform;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5000;

export async function killTree(pid: number, options: KillTreeOptions = {}): Promise<void> {
  const platform = options.platform ?? process.platform;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (platform === "win32") {
    await runTaskkill(pid);
    return;
  }

  await killPosixProcessGroup(pid, timeoutMs);
}

async function runTaskkill(pid: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let stderr = "";
    const child = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true
    });

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", reject);
    child.on("exit", (exitCode, signal) => {
      if (exitCode === 0) {
        resolve();
        return;
      }

      const reason = signal ? `signal=${signal}` : `exitCode=${exitCode ?? "unknown"}`;
      reject(new Error(`taskkill failed for pid=${pid} ${reason}${stderr ? `: ${stderr.trim()}` : ""}`));
    });
  });
}

async function killPosixProcessGroup(pid: number, timeoutMs: number): Promise<void> {
  signalProcessGroup(pid, "SIGTERM");

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) {
      return;
    }

    await delay(100);
  }

  if (isPidAlive(pid)) {
    signalProcessGroup(pid, "SIGKILL");
  }
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") {
      return;
    }

    try {
      process.kill(pid, signal);
    } catch (innerError) {
      const innerCode = (innerError as NodeJS.ErrnoException).code;
      if (innerCode !== "ESRCH") {
        throw innerError;
      }
    }
  }
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
