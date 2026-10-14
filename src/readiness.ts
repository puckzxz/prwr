import net from "node:net";
import http from "node:http";
import https from "node:https";
import { delay } from "./timing.js";
import type { ReadinessCheck } from "./types.js";

export async function waitForReadiness(check: ReadinessCheck, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + check.timeoutMs;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    const timeout = Math.max(1, Math.min(1000, deadline - Date.now()));
    const ready = check.type === "tcp"
      ? await probeTcp(check.host, check.port, timeout, signal)
      : await probeHttp(check.url, timeout, signal);
    signal.throwIfAborted();
    if (ready) return;
    const remaining = deadline - Date.now();
    if (remaining > 0) await delay(Math.min(check.intervalMs, remaining), signal);
  }
  signal.throwIfAborted();
  throw new Error(`Readiness timed out after ${check.timeoutMs}ms.`);
}

function probeTcp(host: string, port: number, timeoutMs: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const timer = setTimeout(() => finish(false), timeoutMs);
    const abort = () => finish(false);
    function finish(ready: boolean): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      socket.destroy();
      resolve(ready);
    }
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("close", () => finish(false));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) finish(false);
  });
}

function probeHttp(url: string, timeoutMs: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const transport = url.startsWith("https:") ? https : http;
    const request = transport.get(url);
    let settled = false;
    const timer = setTimeout(() => finish(false), timeoutMs);
    const abort = () => finish(false);
    function finish(ready: boolean): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      request.destroy();
      resolve(ready);
    }
    request.once("response", (response) => {
      response.resume();
      finish(response.statusCode !== undefined && response.statusCode >= 200 && response.statusCode < 300);
    });
    request.once("error", () => finish(false));
    request.once("close", () => finish(false));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) finish(false);
  });
}
