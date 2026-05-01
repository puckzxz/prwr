import net from "node:net";
import type { ControlCommand, ControlResponse } from "./types.js";

export type ControlCommandHandler = (command: ControlCommand) => Promise<unknown> | unknown;

export interface ControlServerOptions {
  token: string;
  requestTimeoutMs?: number;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
}

export const DEFAULT_CONTROL_REQUEST_TIMEOUT_MS = 5000;
export const DEFAULT_MAX_CONTROL_REQUEST_BYTES = 64 * 1024;
export const DEFAULT_MAX_CONTROL_RESPONSE_BYTES = 1024 * 1024;

interface ControlEnvelope {
  token: string;
  command: ControlCommand;
}

export class ControlServer {
  private readonly server: net.Server;
  private readonly handler: ControlCommandHandler;
  private readonly token: string;
  private readonly requestTimeoutMs: number;
  private readonly maxRequestBytes: number;
  private readonly maxResponseBytes: number;

  constructor(handler: ControlCommandHandler, options: ControlServerOptions) {
    this.handler = handler;
    this.token = options.token;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_CONTROL_REQUEST_TIMEOUT_MS;
    this.maxRequestBytes = options.maxRequestBytes ?? DEFAULT_MAX_CONTROL_REQUEST_BYTES;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_CONTROL_RESPONSE_BYTES;
    this.server = net.createServer({ allowHalfOpen: true }, (socket) => {
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
        receivedBytes += Buffer.byteLength(chunk, "utf8");
        if (receivedBytes > this.maxRequestBytes) {
          finish({ ok: false, error: "Control request is too large." });
          return;
        }

        buffer += chunk;
      });

      socket.on("end", () => {
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
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  private async handleSocketEnd(socket: net.Socket, rawPayload: string): Promise<void> {
    const response = await this.dispatch(rawPayload);
    this.writeResponse(socket, response);
  }

  private writeResponse(socket: net.Socket, response: ControlResponse): void {
    let payload = JSON.stringify(response);
    if (Buffer.byteLength(payload, "utf8") > this.maxResponseBytes) {
      payload = JSON.stringify({ ok: false, error: "Control response is too large." } satisfies ControlResponse);
    }

    socket.end(`${payload}\n`);
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

function isControlEnvelope(value: unknown): value is ControlEnvelope {
  return (
    isRecord(value) &&
    typeof value.token === "string" &&
    value.token.length > 0 &&
    isRecord(value.command) &&
    typeof value.command.type === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
