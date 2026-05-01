import type { ColorMode } from "./types.js";

export interface WritableStreamLike {
  isTTY?: boolean;
  write(chunk: string): unknown;
}

export interface PrefixedLoggerOptions {
  names: string[];
  stdout?: WritableStreamLike;
  stderr?: WritableStreamLike;
  colorMode?: ColorMode;
}

type StreamKind = "stdout" | "stderr";

const RESET = "\u001B[0m";
const COLORS = [
  "\u001B[36m",
  "\u001B[35m",
  "\u001B[33m",
  "\u001B[32m",
  "\u001B[34m",
  "\u001B[31m",
  "\u001B[96m",
  "\u001B[95m",
  "\u001B[93m",
  "\u001B[92m",
  "\u001B[94m",
  "\u001B[91m"
];

export class PrefixedLogger {
  private readonly stdout: WritableStreamLike;
  private readonly stderr: WritableStreamLike;
  private readonly width: number;
  private readonly colorMode: ColorMode;
  private readonly buffers = new Map<string, string>();

  constructor(options: PrefixedLoggerOptions) {
    this.stdout = options.stdout ?? process.stdout;
    this.stderr = options.stderr ?? process.stderr;
    this.colorMode = options.colorMode ?? "auto";
    this.width = Math.max(1, ...options.names.map((name) => name.length));
  }

  write(name: string, stream: StreamKind, chunk: Buffer | string): void {
    const key = `${name}:${stream}`;
    const previous = this.buffers.get(key) ?? "";
    let text = previous + chunk.toString();
    let newlineIndex = text.indexOf("\n");

    while (newlineIndex !== -1) {
      const rawLine = text.slice(0, newlineIndex);
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      this.writeLine(name, stream, line);
      text = text.slice(newlineIndex + 1);
      newlineIndex = text.indexOf("\n");
    }

    this.buffers.set(key, text);
  }

  lifecycle(name: string, message: string, stream: StreamKind = "stdout"): void {
    this.writeLine(name, stream, message);
  }

  flush(name: string, stream?: StreamKind): void {
    const streams: StreamKind[] = stream ? [stream] : ["stdout", "stderr"];

    for (const selectedStream of streams) {
      const key = `${name}:${selectedStream}`;
      const buffered = this.buffers.get(key);
      if (buffered && buffered.length > 0) {
        this.writeLine(name, selectedStream, buffered);
      }
      this.buffers.set(key, "");
    }
  }

  private writeLine(name: string, stream: StreamKind, line: string): void {
    const destination = stream === "stdout" ? this.stdout : this.stderr;
    const prefix = `${name.padEnd(this.width)} | `;
    const renderedPrefix = this.shouldColor(destination) ? colorForName(name, prefix) : prefix;
    destination.write(`${renderedPrefix}${line}\n`);
  }

  private shouldColor(destination: WritableStreamLike): boolean {
    if (process.env.NO_COLOR) {
      return false;
    }

    if (this.colorMode === "always") {
      return true;
    }

    if (this.colorMode === "never") {
      return false;
    }

    return Boolean(destination.isTTY || process.env.FORCE_COLOR);
  }
}

export function colorForName(name: string, value: string): string {
  const color = COLORS[hashName(name) % COLORS.length] ?? COLORS[0];
  return `${color}${value}${RESET}`;
}

export function hashName(name: string): number {
  let hash = 0;
  for (const character of name) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }

  return hash;
}
