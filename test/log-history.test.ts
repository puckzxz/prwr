import { describe, expect, it } from "vitest";
import { LogHistory, MAX_LOG_HISTORY_BYTES, MAX_LOG_TAIL, MAX_LOG_TEXT_BYTES } from "../src/log-history.js";
import { PrefixedLogger } from "../src/logger.js";
import type { ProcessLogEntry } from "../src/types.js";

function entry(text: string, overrides: Partial<ProcessLogEntry> = {}): ProcessLogEntry {
  return {
    name: "api", stream: "stdout", kind: "output", timestamp: "2026-10-14T04:00:00.000Z", text,
    ...overrides
  };
}

describe("log history", () => {
  it("preserves ordered stdout, stderr and lifecycle entries independently per process", () => {
    const history = new LogHistory(["api", "web"]);
    history.add(entry("started", { kind: "lifecycle" }));
    history.add(entry("warning", { stream: "stderr" }));
    history.add(entry("web-ready", { name: "web" }));
    history.add(entry("ready"));

    expect(history.get("api", 2)).toEqual([entry("warning", { stream: "stderr" }), entry("ready")]);
    expect(history.get("web")).toEqual([entry("web-ready", { name: "web" })]);
    expect(history.get("api", 0)).toEqual([]);
  });

  it("limits retained entry count and returns snapshots that cannot mutate history", () => {
    const history = new LogHistory(["api"]);
    for (let index = 0; index < MAX_LOG_TAIL + 10; index += 1) history.add(entry(String(index)));
    const snapshot = history.get("api", MAX_LOG_TAIL);

    expect(snapshot).toHaveLength(MAX_LOG_TAIL);
    expect(snapshot[0]?.text).toBe("10");
    snapshot[0]!.text = "changed";
    snapshot.pop();
    expect(history.get("api", MAX_LOG_TAIL)[0]?.text).toBe("10");
    expect(history.get("api", MAX_LOG_TAIL)).toHaveLength(MAX_LOG_TAIL);
  });

  it("bounds serialized history bytes even for escape-heavy output", () => {
    const history = new LogHistory(["api"]);
    for (let index = 0; index < 100; index += 1) history.add(entry(`${index}\u0000${"\u0000".repeat(2000)}`));
    const snapshot = history.get("api", MAX_LOG_TAIL);
    const serializedBytes = snapshot.reduce((bytes, value) => bytes + Buffer.byteLength(JSON.stringify(value)) + 1, 0);

    expect(serializedBytes).toBeLessThanOrEqual(MAX_LOG_HISTORY_BYTES);
    expect(snapshot.at(-1)?.text).toContain("99\u0000");
    expect(snapshot.length).toBeGreaterThan(0);
    expect(snapshot.length).toBeLessThan(100);
  });

  it("truncates oversized history text without corrupting UTF-8 or changing live output", () => {
    const live: string[] = [];
    const logger = new PrefixedLogger({
      names: ["api"], colorMode: "never", stdout: { write: (chunk) => live.push(chunk) }
    });
    const text = "\u{1F680}".repeat(10000);
    logger.write("api", "stdout", `${text}\n`);
    const retained = logger.getLogs("api").entries[0]!.text;

    expect(live.join("")).toBe(`api | ${text}\n`);
    expect(retained).toContain("[truncated]");
    expect(retained).not.toContain("\uFFFD");
    expect(Buffer.byteLength(retained)).toBeLessThanOrEqual(MAX_LOG_TEXT_BYTES);
  });

  it("captures final partial lines and keeps prior run history without recording reads", () => {
    const logger = new PrefixedLogger({
      names: ["api"], colorMode: "never", stdout: { write: () => undefined }, stderr: { write: () => undefined },
      now: () => new Date("2026-10-14T04:00:00.000Z")
    });
    logger.write("api", "stdout", "before-");
    logger.write("api", "stdout", "restart");
    logger.write("api", "stderr", "error-partial");
    expect(logger.getLogs("api").entries).toEqual([]);
    logger.flush("api");
    logger.lifecycle("api", "restarting...");
    logger.write("api", "stdout", "next-run\n");

    const expected = [entry("before-restart"), entry("error-partial", { stream: "stderr" }),
      entry("restarting...", { kind: "lifecycle" }), entry("next-run")];
    expect(logger.getLogs("api").entries).toEqual(expected);
    expect(logger.getLogs("api").entries).toEqual(expected);
  });

  it.each([-1, 1.5, MAX_LOG_TAIL + 1, Infinity, NaN])("rejects invalid tail %s", (tail) => {
    expect(() => new LogHistory(["api"]).get("api", tail)).toThrow(/Log tail/);
  });

  it("reports unknown process names", () => {
    expect(() => new LogHistory(["api"]).get("missing")).toThrow(/Available processes: api/);
  });
});
