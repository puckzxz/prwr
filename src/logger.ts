import { StringDecoder } from "node:string_decoder";
import { LogHistory, DEFAULT_LOG_TAIL } from "./log-history.js";
import type { ColorMode, LogKind, LogStream, ProcessLogs } from "./types.js";

export interface WritableStreamLike {
  isTTY?: boolean;
  write(chunk: string): unknown;
}

export interface PrefixedLoggerOptions {
  names: string[];
  stdout?: WritableStreamLike;
  stderr?: WritableStreamLike;
  colorMode?: ColorMode;
  timestamps?: boolean;
  now?: () => Date;
}

type StreamKind = LogStream;

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
  private readonly timestamps: boolean;
  private readonly now: () => Date;
  private readonly buffers = new Map<string, { text: string; decoder: StringDecoder }>();
  private readonly history: LogHistory;

  constructor(options: PrefixedLoggerOptions) {
    this.stdout = options.stdout ?? process.stdout;
    this.stderr = options.stderr ?? process.stderr;
    this.colorMode = options.colorMode ?? "auto";
    this.timestamps = options.timestamps ?? false;
    this.now = options.now ?? (() => new Date());
    this.width = Math.max(1, ...options.names.map((name) => name.length));
    this.history = new LogHistory(options.names);
  }

  write(name: string, stream: StreamKind, chunk: Buffer | string): void {
    const key = `${name}:${stream}`;
    const buffer = this.buffers.get(key) ?? { text: "", decoder: new StringDecoder("utf8") };
    const decoded = typeof chunk === "string" ? buffer.decoder.end() + chunk : buffer.decoder.write(chunk);
    let text = buffer.text + decoded;
    let newlineIndex = text.indexOf("\n");

    while (newlineIndex !== -1) {
      const rawLine = text.slice(0, newlineIndex);
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      this.writeLine(name, stream, line);
      text = text.slice(newlineIndex + 1);
      newlineIndex = text.indexOf("\n");
    }

    buffer.text = text;
    this.buffers.set(key, buffer);
  }

  lifecycle(name: string, message: string, stream: StreamKind = "stdout"): void {
    this.writeLine(name, stream, message, "lifecycle");
  }

  flush(name: string, stream?: StreamKind): void {
    const streams: StreamKind[] = stream ? [stream] : ["stdout", "stderr"];

    for (const selectedStream of streams) {
      const key = `${name}:${selectedStream}`;
      const buffer = this.buffers.get(key);
      const buffered = buffer ? buffer.text + buffer.decoder.end() : "";
      if (buffered && buffered.length > 0) {
        this.writeLine(name, selectedStream, buffered);
      }
      this.buffers.delete(key);
    }
  }

  getLogs(name: string, tail = DEFAULT_LOG_TAIL): ProcessLogs {
    return { name, entries: this.history.get(name, tail) };
  }

  private writeLine(name: string, stream: StreamKind, line: string, kind: LogKind = "output"): void {
    const destination = stream === "stdout" ? this.stdout : this.stderr;
    const now = this.now();
    this.history.add({ name, stream, kind, text: line, timestamp: now.toISOString() });
    const timestamp = this.timestamps ? `${formatLocalTime(now)} ` : "";
    const prefix = `${name.padEnd(this.width)} | `;
    const renderedPrefix = shouldColorLabels(this.colorMode, destination) ? colorForName(name, prefix) : prefix;
    destination.write(`${timestamp}${renderedPrefix}${line}\n`);
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

export function formatLocalTime(date: Date): string {
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((value) => String(value).padStart(2, "0"))
    .join(":");
}

export function shouldColorLabels(colorMode: ColorMode, destination: WritableStreamLike): boolean {
  if (process.env.NO_COLOR) {
    return false;
  }

  if (colorMode === "always") {
    return true;
  }

  if (colorMode === "never") {
    return false;
  }

  return Boolean(destination.isTTY || process.env.FORCE_COLOR);
}
