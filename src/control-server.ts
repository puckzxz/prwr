import net from "node:net";
import type { ControlCommand, ControlResponse } from "./types.js";

export type ControlCommandHandler = (command: ControlCommand) => Promise<unknown> | unknown;

export class ControlServer {
  private readonly server: net.Server;
  private readonly handler: ControlCommandHandler;

  constructor(handler: ControlCommandHandler) {
    this.handler = handler;
    this.server = net.createServer((socket) => {
      let buffer = "";

      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        buffer += chunk;
      });

      socket.on("end", () => {
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
    socket.end(`${JSON.stringify(response)}\n`);
  }

  private async dispatch(rawPayload: string): Promise<ControlResponse> {
    let command: ControlCommand;
    try {
      command = JSON.parse(rawPayload) as ControlCommand;
    } catch {
      return { ok: false, error: "Invalid JSON command." };
    }

    try {
      const data = await this.handler(command);
      return { ok: true, data };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}
