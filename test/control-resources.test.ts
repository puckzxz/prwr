import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readVerifiedSupervisorState, stateFilePath, writeSupervisorState } from "../src/control-client.js";
import { ControlServer } from "../src/control-server.js";
import { runUp } from "../src/supervisor.js";
import type { SupervisorStateFile } from "../src/types.js";
import { close, listen, trackConnections, unusedPort } from "./helpers/readiness.js";

const directories: string[] = [];

function project(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "prwr-control-resources-"));
  directories.push(dir);
  writeFileSync(path.join(dir, ".prwr.yml"), "processes:\n  web:\n    command: node -e \"setInterval(() => {}, 1000)\"\n");
  return dir;
}

function stateFor(projectRoot: string, port: number): SupervisorStateFile {
  return {
    supervisorPid: process.pid,
    projectRoot,
    configPath: path.join(projectRoot, ".prwr.yml"),
    port,
    token: "test-control-token",
    startedAt: new Date().toISOString()
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of directories.splice(0)) {
    const resolved = path.resolve(dir);
    if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith("prwr-control-resources-")) {
      throw new Error("Refusing to remove an unexpected test path.");
    }
    rmSync(resolved, { recursive: true, force: true });
  }
});

async function connect(port: number): Promise<net.Socket> {
  const socket = net.createConnection({ host: "127.0.0.1", port, allowHalfOpen: true });
  socket.on("error", () => undefined);
  await once(socket, "connect");
  return socket;
}

async function within<T>(promise: Promise<T>, timeoutMs = 1500): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Control server did not close within its deadline.")), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe("control connection cleanup", () => {
  it.each(["incomplete", "timeout", "oversized"] as const)(
    "closes a half-open %s request without requiring the peer to end",
    async (kind) => {
      const server = new ControlServer(() => ({}), {
        token: "token", requestTimeoutMs: kind === "timeout" ? 20 : 5000, maxRequestBytes: 8
      });
      const port = await server.listen();
      const socket = await connect(port);
      let response = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => { response += chunk; });
      try {
        if (kind !== "incomplete") {
          const ended = once(socket, "end");
          if (kind === "oversized") socket.write("x".repeat(9));
          await within(ended);
          expect(JSON.parse(response)).toMatchObject({
            ok: false, error: kind === "timeout" ? "Control request timed out." : "Control request is too large."
          });
        }
        await within(server.close());
        await expect(connect(port)).rejects.toMatchObject({ code: "ECONNREFUSED" });
      } finally {
        socket.destroy();
        await server.close();
      }
    }
  );

  it("bounds shutdown while a complete request's handler is still pending", async () => {
    let release: (value: unknown) => void = () => undefined;
    let received: () => void = () => undefined;
    const handled = new Promise<void>((resolve) => { received = resolve; });
    const server = new ControlServer(() => {
      received();
      return new Promise((resolve) => { release = resolve; });
    }, { token: "token", closeGraceMs: 30 });
    const port = await server.listen();
    const socket = await connect(port);
    socket.pause();
    socket.end(JSON.stringify({ token: "token", command: { type: "status" } }));
    try {
      await within(handled);
      await within(server.close());
      release({ value: "late reply" });
      await delay(0);
      await expect(connect(port)).rejects.toMatchObject({ code: "ECONNREFUSED" });
    } finally {
      release({});
      socket.destroy();
      await server.close();
    }
  });

  it("drains an ordinary shutdown reply before closing", async () => {
    const server = new ControlServer(() => {
      setTimeout(() => { void server.close(); }, 0);
      return { message: "stopping" };
    }, { token: "token" });
    const port = await server.listen();
    const socket = await connect(port);
    let response = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { response += chunk; });
    const ended = once(socket, "end");
    socket.end(JSON.stringify({ token: "token", command: { type: "down" } }));
    try {
      await within(ended);
      expect(JSON.parse(response)).toEqual({ ok: true, data: { message: "stopping" } });
      await within(server.close());
    } finally {
      socket.destroy();
      await server.close();
    }
  });
});

describe("supervisor setup and identity failures", () => {
  it("preserves a live supervisor's state when its port is unreachable", async () => {
    const dir = project();
    const state = stateFor(dir, await unusedPort());
    writeSupervisorState(state);
    await expect(readVerifiedSupervisorState(dir)).rejects.toThrow(/Existing state has been preserved/);
    expect(JSON.parse(readFileSync(stateFilePath(dir), "utf8"))).toEqual(state);
  });

  it("preserves live state when the peer closes without an identity reply", async () => {
    const dir = project();
    const server = net.createServer({ allowHalfOpen: true }, (socket) => {
      socket.resume();
      socket.on("end", () => socket.end());
    });
    const sockets = trackConnections(server);
    const state = stateFor(dir, await listen(server));
    writeSupervisorState(state);
    try {
      await expect(readVerifiedSupervisorState(dir)).rejects.toThrow(/without a response.*preserved/);
      expect(existsSync(stateFilePath(dir))).toBe(true);
    } finally {
      await close(server, sockets);
    }
  });

  it("refuses duplicate startup when a live supervisor's identity probe times out", async () => {
    const dir = project();
    const server = new ControlServer(async () => {
      await delay(5200);
      return {};
    }, { token: "test-control-token" });
    const state = stateFor(dir, await server.listen());
    writeSupervisorState(state);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await expect(runUp({ cwd: dir, colorMode: "never", timestamps: false })).rejects.toThrow(/Timed out.*preserved/);
      expect(JSON.parse(readFileSync(stateFilePath(dir), "utf8"))).toEqual(state);
      expect(log).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("closes the listening server if the runtime state cannot be written", async () => {
    const dir = project();
    writeFileSync(path.join(dir, ".prwr"), "a file occupies the runtime directory");
    const originalListen = ControlServer.prototype.listen;
    const started: ControlServer[] = [];
    let port = 0;
    vi.spyOn(ControlServer.prototype, "listen").mockImplementation(async function (this: ControlServer) {
      started.push(this);
      port = await originalListen.call(this);
      return port;
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await expect(runUp({ cwd: dir, colorMode: "never", timestamps: false })).rejects.toThrow();
      expect(port).toBeGreaterThan(0);
      await expect(connect(port)).rejects.toMatchObject({ code: "ECONNREFUSED" });
      expect(existsSync(stateFilePath(dir))).toBe(false);
    } finally {
      for (const server of started) await server.close();
    }
  });
});
