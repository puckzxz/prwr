import { describe, expect, it } from "vitest";
import { colorForName, PrefixedLogger, type WritableStreamLike } from "../src/logger.js";

class MemoryStream implements WritableStreamLike {
  isTTY = false;
  value = "";

  write(chunk: string): void {
    this.value += chunk;
  }
}

describe("PrefixedLogger", () => {
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
});
