import net from "node:net";
import { isControlEnvelope } from "./control-protocol.js";
import type { ControlCommand, ControlEnvelope, ControlResponse } from "./types.js";

export type ControlCommandHandler = (command: ControlCommand) => Promise<unknown> | unknown;

export interface ControlServerOptions {
  token: string;
  requestTimeoutMs?: number;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
  closeGraceMs?: number;
}

export const DEFAULT_CONTROL_REQUEST_TIMEOUT_MS = 5000;
export const DEFAULT_MAX_CONTROL_REQUEST_BYTES = 64 * 1024;
export const DEFAULT_MAX_CONTROL_RESPONSE_BYTES = 1024 * 1024;
export const DEFAULT_CONTROL_CLOSE_GRACE_MS = 1000;

export class ControlServer {
  private readonly server: net.Server;
  private readonly handler: ControlCommandHandler;
  private readonly token: string;
  private readonly requestTimeoutMs: number;
  private readonly maxRequestBytes: number;
  private readonly maxResponseBytes: number;
  private readonly closeGraceMs: number;
  private readonly connections = new Set<net.Socket>();
  private readonly pendingRequests = new Set<net.Socket>();
  private closePromise: Promise<void> | null = null;

  constructor(handler: ControlCommandHandler, options: ControlServerOptions) {
    this.handler = handler;
    this.token = options.token;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_CONTROL_REQUEST_TIMEOUT_MS;
    this.maxRequestBytes = options.maxRequestBytes ?? DEFAULT_MAX_CONTROL_REQUEST_BYTES;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_CONTROL_RESPONSE_BYTES;
    this.closeGraceMs = options.closeGraceMs ?? DEFAULT_CONTROL_CLOSE_GRACE_MS;
    this.server = net.createServer({ allowHalfOpen: true }, (socket) => {
      this.connections.add(socket);
      this.pendingRequests.add(socket);
      socket.once("close", () => {
        this.connections.delete(socket);
        this.pendingRequests.delete(socket);
      });
      let buffer = "";
      let receivedBytes = 0;
      let settled = false;

      const finish = (response: ControlResponse) => {
        if (settled) {
          return;
        }

        settled = true;
        socket.setTimeout(0);
        this.writeResponse(socket, response);
      };

      socket.setEncoding("utf8");
      socket.setTimeout(this.requestTimeoutMs, () => {
        finish({ ok: false, error: "Control request timed out." });
      });

      socket.on("data", (chunk) => {
        if (settled) return;
        receivedBytes += Buffer.byteLength(chunk, "utf8");
        if (receivedBytes > this.maxRequestBytes) {
          finish({ ok: false, error: "Control request is too large." });
          return;
        }

        buffer += chunk;
      });

      socket.on("end", () => {
        this.pendingRequests.delete(socket);
        if (settled) {
          return;
        }

        settled = true;
        socket.setTimeout(0);
        void this.handleSocketEnd(socket, buffer);
      });

      socket.on("error", () => {
        socket.destroy();
      });
    });
  }

  async listen(): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.off("error", reject);
        resolve();
      });
    });

    const address = this.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Control server did not bind to a TCP port.");
    }

    return address.port;
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = new Promise<void>((resolve, reject) => {
      // Let completed commands drain their replies, but never rely on a peer to close.
      const deadline = setTimeout(() => {
        for (const socket of this.connections) socket.destroy();
      }, this.closeGraceMs);
      deadline.unref();
      this.server.close((error) => {
        clearTimeout(deadline);
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
    for (const socket of this.pendingRequests) socket.destroy();
    return this.closePromise;
  }

  private async handleSocketEnd(socket: net.Socket, rawPayload: string): Promise<void> {
    const response = await this.dispatch(rawPayload);
    this.writeResponse(socket, response);
  }

  private writeResponse(socket: net.Socket, response: ControlResponse): void {
    if (socket.destroyed) return;
    let payload = JSON.stringify(response);
    if (Buffer.byteLength(payload, "utf8") > this.maxResponseBytes) {
      payload = JSON.stringify({ ok: false, error: "Control response is too large." } satisfies ControlResponse);
    }

    socket.end(`${payload}\n`, () => socket.destroy());
  }

  private async dispatch(rawPayload: string): Promise<ControlResponse> {
    let envelope: ControlEnvelope;
    try {
      envelope = JSON.parse(rawPayload) as ControlEnvelope;
    } catch {
      return { ok: false, error: "Invalid JSON command." };
    }

    if (!isControlEnvelope(envelope)) {
      return { ok: false, error: "Invalid control command." };
    }

    if (envelope.token !== this.token) {
      return { ok: false, error: "Unauthorized control command." };
    }

    try {
      const data = await this.handler(envelope.command);
      return { ok: true, data };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}
