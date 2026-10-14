import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { performance } from "node:perf_hooks";
import { isPidAlive } from "../../src/kill-tree.js";

interface ObservedProcess {
  child: ChildProcess;
  stdout: string;
}

export function observeProcessSpawns() {
  const runs: ObservedProcess[] = [];
  const spawnProcess = ((...args: Parameters<typeof spawn>) => {
    const run = { child: spawn(...args), stdout: "" };
    run.child.stdout?.on("data", (chunk: Buffer) => { run.stdout += chunk.toString("utf8"); });
    runs.push(run);
    return run.child;
  }) as typeof spawn;
  return { runs, spawnProcess };
}

export async function waitForGrandchildOutput(runs: ObservedProcess[], index: number): Promise<number> {
  let pid = 0;
  try {
    await waitForRealTime(() => {
      const output = runs[index]?.stdout;
      const match = output?.match(/grandchild=(\d+)\n/);
      pid = match ? Number(match[1]) : 0;
      return pid > 0 && isPidAlive(pid) && !!output?.endsWith("final-partial");
    });
  } catch (error) {
    throw new Error(`Process fixture ${index + 1} did not produce a live grandchild and complete partial output. stdout=${JSON.stringify(runs[index]?.stdout ?? "")}`, { cause: error });
  }
  return pid;
}

// Date.now may be controlled to advance readiness deadlines; fixture setup stays
// bounded by a separate monotonic clock and real timers.
export async function waitForRealTime(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error("Timed out waiting for fixture state.");
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

export async function listen(server: net.Server, port = 0): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error) => reject(error);
    server.once("error", failed);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", failed);
      resolve();
    });
  });
  return (server.address() as net.AddressInfo).port;
}

export async function unusedPort(): Promise<number> {
  const server = net.createServer();
  const port = await listen(server);
  await close(server);
  return port;
}

export function trackConnections(server: net.Server): Set<net.Socket> {
  const sockets = new Set<net.Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  return sockets;
}

export async function close(server: net.Server, sockets = new Set<net.Socket>()): Promise<void> {
  for (const socket of sockets) socket.destroy();
  if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
}
