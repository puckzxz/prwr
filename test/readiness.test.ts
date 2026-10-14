import { getEventListeners } from "node:events";
import http from "node:http";
import net from "node:net";
import { describe, expect, it, vi } from "vitest";
import { waitForReadiness } from "../src/readiness.js";
import { waitFor } from "./helpers/process-manager.js";
import { close, listen, trackConnections, unusedPort, waitForRealTime } from "./helpers/readiness.js";

describe("readiness probes", () => {
  it("keeps fixture setup bounded while the readiness deadline clock is frozen", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(0);
    try {
      await expect(waitForRealTime(() => false, 25)).rejects.toThrow("Timed out waiting for fixture state.");
    } finally {
      clock.mockRestore();
    }
  });

  it("connects to TCP and closes the probe socket and abort listener", async () => {
    const server = net.createServer();
    const sockets = trackConnections(server);
    const port = await listen(server);
    const controller = new AbortController();
    try {
      await waitForReadiness({ type: "tcp", host: "127.0.0.1", port, timeoutMs: 1000, intervalMs: 10 }, controller.signal);
      await waitFor(() => sockets.size === 0);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    } finally {
      await close(server, sockets);
    }
  });

  it("retries HTTP failures until a 2xx response", async () => {
    let requests = 0;
    const server = http.createServer((_, response) => {
      requests += 1;
      response.writeHead(requests < 3 ? 503 : 204).end();
    });
    const sockets = trackConnections(server);
    const port = await listen(server);
    const controller = new AbortController();
    try {
      await waitForReadiness({ type: "http", url: `http://127.0.0.1:${port}/health`, timeoutMs: 1000, intervalMs: 10 }, controller.signal);
      expect(requests).toBe(3);
      await waitFor(() => sockets.size === 0);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    } finally {
      await close(server, sockets);
    }
  });

  it("does not treat redirects as healthy or follow them", async () => {
    const paths: string[] = [];
    const server = http.createServer((request, response) => {
      paths.push(request.url!);
      response.writeHead(302, { location: "/success" }).end();
    });
    const sockets = trackConnections(server);
    const port = await listen(server);
    const controller = new AbortController();
    try {
      await expect(waitForReadiness({ type: "http", url: `http://127.0.0.1:${port}/redirect`, timeoutMs: 80, intervalMs: 10 }, controller.signal))
        .rejects.toThrow("Readiness timed out after 80ms.");
      expect(paths.length).toBeGreaterThan(0);
      expect(new Set(paths)).toEqual(new Set(["/redirect"]));
      await waitFor(() => sockets.size === 0);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    } finally {
      await close(server, sockets);
    }
  });

  it("uses successful HTTP headers without waiting for an unbounded response body", async () => {
    const server = http.createServer((_, response) => {
      response.writeHead(200).write("unfinished body");
    });
    const sockets = trackConnections(server);
    const port = await listen(server);
    const controller = new AbortController();
    try {
      await waitForReadiness({ type: "http", url: `http://127.0.0.1:${port}`, timeoutMs: 1000, intervalMs: 10 }, controller.signal);
      await waitFor(() => sockets.size === 0);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    } finally {
      await close(server, sockets);
    }
  });

  it("aborts a hanging HTTP response and closes its socket", async () => {
    let received!: () => void;
    const requestReceived = new Promise<void>((resolve) => { received = resolve; });
    const server = http.createServer(() => received());
    const sockets = trackConnections(server);
    const port = await listen(server);
    const controller = new AbortController();
    try {
      const pending = waitForReadiness({ type: "http", url: `http://127.0.0.1:${port}`, timeoutMs: 10000, intervalMs: 10 }, controller.signal);
      const rejected = expect(pending).rejects.toThrow("cancel probe");
      await requestReceived;
      controller.abort(new Error("cancel probe"));
      await rejected;
      await waitFor(() => sockets.size === 0);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    } finally {
      controller.abort();
      await close(server, sockets);
    }
  });

  it("times out a hanging HTTP response and closes its socket", async () => {
    let requests = 0;
    const server = http.createServer(() => { requests += 1; });
    const sockets = trackConnections(server);
    const port = await listen(server);
    const controller = new AbortController();
    try {
      await expect(waitForReadiness({ type: "http", url: `http://127.0.0.1:${port}`, timeoutMs: 100, intervalMs: 10 }, controller.signal))
        .rejects.toThrow("Readiness timed out after 100ms.");
      expect(requests).toBeGreaterThan(0);
      await waitFor(() => sockets.size === 0);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    } finally {
      await close(server, sockets);
    }
  });

  it("cancels the retry interval after a refused TCP connection", async () => {
    const port = await unusedPort();
    const controller = new AbortController();
    let closed!: () => void;
    const probeClosed = new Promise<void>((resolve) => { closed = resolve; });
    const originalConnect = net.createConnection;
    const connect = vi.spyOn(net, "createConnection").mockImplementation((...args: Parameters<typeof net.createConnection>) => {
      const socket = originalConnect(...args);
      socket.once("close", closed);
      return socket;
    });
    try {
      const pending = waitForReadiness({ type: "tcp", host: "127.0.0.1", port, timeoutMs: 10000, intervalMs: 9000 }, controller.signal);
      const rejected = expect(pending).rejects.toThrow("cancel interval");
      await probeClosed;
      controller.abort(new Error("cancel interval"));
      await rejected;
      expect(connect).toHaveBeenCalledTimes(1);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    } finally {
      controller.abort();
      connect.mockRestore();
    }
  });

  it("does not open a socket for an already-cancelled probe", async () => {
    const controller = new AbortController();
    controller.abort(new Error("already cancelled"));
    const connect = vi.spyOn(net, "createConnection");
    try {
      await expect(waitForReadiness({ type: "tcp", host: "127.0.0.1", port: 1, timeoutMs: 1000, intervalMs: 10 }, controller.signal))
        .rejects.toThrow("already cancelled");
      expect(connect).not.toHaveBeenCalled();
    } finally {
      connect.mockRestore();
    }
  });
});
