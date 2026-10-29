import { describe, expect, it } from "vitest";
import { isJsonRequest, parseCliArgs } from "../src/cli-args.js";
import { DEFAULT_WAIT_TIMEOUT_MS } from "../src/process-wait.js";
import { MAX_TIMER_MS } from "../src/timing.js";

describe("CLI project targeting", () => {
  it.each([
    ["status"], ["down"], ["start", "api"], ["stop", "api"], ["restart", "api"],
    ["logs", "api", "--tail", "2"], ["send", "api", "reload"], ["wait", "api"], ["up"], ["check"]
  ])("accepts --config around command %s", (...args) => {
    const plain = parseCliArgs(args);
    expect(parseCliArgs(["--config", "project/.prwr.yml", ...args])).toEqual({ ...plain, configPath: "project/.prwr.yml" });
    expect(parseCliArgs([...args, "--config", "project/.prwr.yml"])).toEqual({ ...plain, configPath: "project/.prwr.yml" });
    expect(parseCliArgs([...args, "--config=project/.prwr.yml"])).toEqual({ ...plain, configPath: "project/.prwr.yml" });
  });

  it("preserves config-looking text and process names after --", () => {
    expect(parseCliArgs(["send", "--config", "project/.prwr.yml", "api", "--", "--config", "other.yml", "--json"]))
      .toMatchObject({ configPath: "project/.prwr.yml", command: { type: "send", name: "api", text: "--config other.yml --json" } });
    expect(parseCliArgs(["restart", "--", "--config"])).toMatchObject({ command: { name: "--config" } });
    expect(parseCliArgs(["--", "--config"])).toMatchObject({ type: "up", positionalPath: "--config" });
  });

  it.each([
    ["status", "--config"], ["--config", "--json", "status"], ["down", "--config="],
    ["status", "--config", " "], ["--config", "a.yml", "status", "--config=b.yml"]
  ])("rejects invalid project options %s", (...args) => {
    expect(() => parseCliArgs(args)).toThrow(/Option --config/);
  });

  it.each([
    ["status", "--json", "--config"], ["--config", "--json", "status"],
    ["--config=", "wait", "--json"], ["wait", "--json", "--timeout", "NaN"]
  ])("recognizes JSON errors despite malformed options %s", (...args) => {
    expect(isJsonRequest(args)).toBe(true);
  });

  it("does not treat literal JSON flags or config names as output options", () => {
    expect(isJsonRequest(["status", "--", "--json"])).toBe(false);
    expect(isJsonRequest(["--config", "status", "up", "--json"])).toBe(false);
    expect(() => parseCliArgs(["status", "--", "--json"])).toThrow(/does not accept arguments/);
  });
});

describe("wait arguments", () => {
  it("defaults to all supervisor processes and a bounded timeout", () => {
    expect(parseCliArgs(["wait"])).toEqual({ type: "wait", names: [], timeoutMs: DEFAULT_WAIT_TIMEOUT_MS, json: false });
  });

  it("accepts names, JSON, and a timeout in any option position", () => {
    expect(parseCliArgs(["wait", "--json", "api", "--timeout", "5000", "web", "api"]))
      .toEqual({ type: "wait", names: ["api", "web"], timeoutMs: 5000, json: true });
    expect(parseCliArgs(["wait", "--timeout=1", "--", "--json", "--timeout"]))
      .toEqual({ type: "wait", names: ["--json", "--timeout"], timeoutMs: 1, json: false });
    expect(parseCliArgs(["wait", "--timeout", String(MAX_TIMER_MS)])).toMatchObject({ timeoutMs: MAX_TIMER_MS });
  });

  it.each(["0", "-1", "1.5", "1e3", "30s", "NaN", "Infinity", "", String(MAX_TIMER_MS + 1)])
    ("rejects invalid timeout %s", (value) => {
      expect(() => parseCliArgs(["wait", `--timeout=${value}`])).toThrow(/Wait timeout must be an integer/);
    });

  it("rejects missing, repeated, or unknown options", () => {
    expect(() => parseCliArgs(["wait", "--timeout"])).toThrow(/requires a value/);
    expect(() => parseCliArgs(["wait", "--timeout", "1", "--timeout=2"])).toThrow(/only be specified once/);
    expect(() => parseCliArgs(["wait", "--unknown"])).toThrow(/Unknown option/);
  });
});
