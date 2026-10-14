import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  colorForName,
  formatLocalTime,
  PrefixedLogger,
  type WritableStreamLike
} from "../src/logger.js";

class MemoryStream implements WritableStreamLike {
  isTTY = false;
  value = "";

  write(chunk: string): void {
    this.value += chunk;
  }
}

describe("PrefixedLogger", () => {
  beforeEach(() => {
    vi.stubEnv("NO_COLOR", undefined);
    vi.stubEnv("FORCE_COLOR", undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("prefixes and pads complete lines", () => {
    const stdout = new MemoryStream();
    const logger = new PrefixedLogger({ names: ["gui", "backend"], stdout, colorMode: "never" });

    logger.write("gui", "stdout", "hello\nworld\n");

    expect(stdout.value).toBe("gui     | hello\ngui     | world\n");
  });

  it("buffers partial lines and flushes final partial output", () => {
    const stdout = new MemoryStream();
    const logger = new PrefixedLogger({ names: ["api"], stdout, colorMode: "never" });

    logger.write("api", "stdout", "hel");
    logger.write("api", "stdout", "lo\npart");
    logger.flush("api", "stdout");

    expect(stdout.value).toBe("api | hello\napi | part\n");
  });

  it("preserves UTF-8 characters split across chunks on independent streams", () => {
    const stdout = new MemoryStream();
    const stderr = new MemoryStream();
    const logger = new PrefixedLogger({ names: ["api"], stdout, stderr, colorMode: "never" });
    const output = Buffer.from("ready \u{1F680}\n");
    const error = Buffer.from("caf\u00e9");

    logger.write("api", "stdout", output.subarray(0, 8));
    logger.write("api", "stderr", error.subarray(0, 4));
    logger.write("api", "stdout", output.subarray(8));
    logger.write("api", "stderr", error.subarray(4));
    logger.flush("api");

    expect(stdout.value).toBe("api | ready \u{1F680}\n");
    expect(stderr.value).toBe("api | caf\u00e9\n");
  });

  it("flushes incomplete UTF-8 once and resets decoding for the next run", () => {
    const stdout = new MemoryStream();
    const logger = new PrefixedLogger({ names: ["api"], stdout, colorMode: "never" });

    logger.write("api", "stdout", Buffer.from([0xe2, 0x82]));
    expect(stdout.value).toBe("");
    logger.flush("api");
    logger.flush("api");
    logger.write("api", "stdout", Buffer.from("next\n"));

    expect(stdout.value).toBe("api | \uFFFD\napi | next\n");
  });

  it("honors NO_COLOR even when label colors are forced", () => {
    vi.stubEnv("NO_COLOR", "1");
    const stdout = new MemoryStream();
    const logger = new PrefixedLogger({ names: ["api"], stdout, colorMode: "always" });

    logger.write("api", "stdout", "ready\n");

    expect(stdout.value).toBe("api | ready\n");
  });

  it("colors only the prefix when forced", () => {
    const stdout = new MemoryStream();
    const logger = new PrefixedLogger({ names: ["api"], stdout, colorMode: "always" });

    logger.write("api", "stdout", "plain child output\n");

    expect(stdout.value).toContain("\u001B[");
    expect(stdout.value.endsWith("plain child output\n")).toBe(true);
  });

  it("uses stable name colors", () => {
    expect(colorForName("backend", "backend | ")).toBe(colorForName("backend", "backend | "));
  });

  it("prefixes local timestamps before process names when enabled", () => {
    const stdout = new MemoryStream();
    const logger = new PrefixedLogger({
      names: ["api"],
      stdout,
      colorMode: "never",
      timestamps: true,
      now: () => new Date(2026, 4, 1, 14, 32, 7)
    });

    logger.write("api", "stdout", "ready\n");

    expect(stdout.value).toBe("14:32:07 api | ready\n");
  });

  it("leaves timestamps uncolored when labels are colored", () => {
    const stdout = new MemoryStream();
    const logger = new PrefixedLogger({
      names: ["api"],
      stdout,
      colorMode: "always",
      timestamps: true,
      now: () => new Date(2026, 4, 1, 14, 32, 7)
    });

    logger.write("api", "stdout", "ready\n");

    expect(stdout.value.startsWith("14:32:07 \u001B[")).toBe(true);
    expect(stdout.value.endsWith("ready\n")).toBe(true);
  });

  it("formats local times with zero padding", () => {
    expect(formatLocalTime(new Date(2026, 4, 1, 4, 5, 6))).toBe("04:05:06");
  });
});
