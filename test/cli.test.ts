import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { main, parseCliArgs } from "../src/cli.js";
import { DEFAULT_LOG_TAIL, MAX_LOG_TAIL } from "../src/log-history.js";

describe("parseCliArgs", () => {
  it("treats bare prwr as up", () => {
    expect(parseCliArgs([])).toMatchObject({ type: "up", colorMode: "always" });
  });

  it("parses positional config shorthand", () => {
    expect(parseCliArgs(["./.prwr.yml"])).toMatchObject({
      type: "up",
      positionalPath: "./.prwr.yml"
    });
  });

  it("parses control commands", () => {
    expect(parseCliArgs(["restart", "backend"])).toEqual({
      type: "control",
      colorMode: "always",
      command: { type: "restart", name: "backend" }
    });
  });

  it("parses color flags", () => {
    expect(parseCliArgs(["--no-color", "up"])).toMatchObject({
      type: "up",
      colorMode: "never"
    });
    expect(parseCliArgs(["--color", "up"])).toMatchObject({
      type: "up",
      colorMode: "always"
    });
  });

  it("parses timestamp flags for up commands", () => {
    expect(parseCliArgs(["--timestamps"])).toMatchObject({
      type: "up",
      timestamps: true
    });
    expect(parseCliArgs(["up", "--timestamps"])).toMatchObject({
      type: "up",
      timestamps: true
    });
  });

  it("parses send commands by joining text arguments", () => {
    expect(parseCliArgs(["send", "web", "rs"])).toEqual({
      type: "control",
      colorMode: "always",
      command: { type: "send", name: "web", text: "rs" }
    });
    expect(parseCliArgs(["send", "web", "reload", "now"])).toMatchObject({
      command: { type: "send", name: "web", text: "reload now" }
    });
  });

  it("parses check commands with config options", () => {
    expect(parseCliArgs(["check", "--config", "./.prwr.yml"])).toEqual({
      type: "check",
      configPath: "./.prwr.yml",
      procfilePath: undefined,
      positionalPath: undefined
    });
  });

  it("parses JSON status without adding options to the control protocol", () => {
    expect(parseCliArgs(["--no-color", "status", "--json"])).toEqual({
      type: "control", colorMode: "never", command: { type: "status" }, json: true
    });
    expect(() => parseCliArgs(["status", "--json", "api"])).toThrow(/does not accept arguments/);
    expect(() => parseCliArgs(["logs", "api", "--json"])).toThrow(/Unknown option/);
  });

  it("combines comma-separated and repeated process selectors", () => {
    expect(parseCliArgs(["up", "--only", "web, api", "--only", "web,worker", "--exclude", "mail", "--exclude", "debug,mail"]))
      .toMatchObject({ type: "up", only: ["web", "api", "worker"], exclude: ["mail", "debug"] });
    expect(parseCliArgs(["check", "./.prwr.yml", "--only", "web"])).toMatchObject({
      type: "check", positionalPath: "./.prwr.yml", only: ["web"]
    });
    expect(parseCliArgs(["--only", "web"])).toMatchObject({ type: "up", only: ["web"] });
  });

  it.each([[], ["--tail"], ["--tail", String(DEFAULT_LOG_TAIL)]].map((options) => ({ options })))
    ("defaults recent logs with options $options", ({ options }) => {
      expect(parseCliArgs(["logs", "web", ...options])).toMatchObject({
        command: { type: "logs", name: "web", tail: DEFAULT_LOG_TAIL }
      });
    });

  it.each([0, MAX_LOG_TAIL])("accepts log tail boundary %i", (tail) => {
    expect(parseCliArgs(["logs", "web", "--tail", String(tail)])).toMatchObject({
      command: { type: "logs", name: "web", tail }
    });
  });

  it.each(["-1", "1.5", "1e2", "NaN", "Infinity", String(MAX_LOG_TAIL + 1), "--unknown"])
    ("rejects invalid log tail %s", (tail) => {
      expect(() => parseCliArgs(["logs", "web", "--tail", tail])).toThrow(/Log tail must be an integer/);
    });

  it.each([["logs"], ["logs", "web", "other"], ["logs", "web", "--tail", "1", "extra"]].map((args) => ({ args })))
    ("rejects malformed logs command $args", ({ args }) => {
      expect(() => parseCliArgs(args)).toThrow();
    });

  it.each([["up", "--only"], ["up", "--exclude", "--config"], ["up", "--only", "web,,api"], ["up", "--exclude", " "], ["up", "--only="]].map((args) => ({ args })))
    ("rejects missing or empty selector names $args", ({ args }) => {
      expect(() => parseCliArgs(args)).toThrow(/requires/);
    });

  it("preserves literal send payloads after the end-of-options marker", () => {
    expect(parseCliArgs(["--no-color", "send", "web", "--", "--color", "--timestamps", "--", "reload"]))
      .toEqual({
        type: "control", colorMode: "never",
        command: { type: "send", name: "web", text: "--color --timestamps -- reload" }
      });
    expect(parseCliArgs(["send", "web", "--", "--"])).toMatchObject({ command: { text: "--" } });
    expect(() => parseCliArgs(["send", "web", "--"])).toThrow(/requires text/);
  });

  it("accepts legal process names beginning with dashes", () => {
    expect(parseCliArgs(["restart", "-api"])).toMatchObject({ command: { type: "restart", name: "-api" } });
    expect(parseCliArgs(["logs", "--tail"])).toMatchObject({ command: { type: "logs", name: "--tail" } });
    expect(parseCliArgs(["logs", "--", "--color"])).toMatchObject({ command: { type: "logs", name: "--color" } });
    expect(parseCliArgs(["send", "--", "--color", "--", "--"])).toMatchObject({ command: { type: "send", name: "--color", text: "--" } });
    expect(parseCliArgs(["up", "--only", "-api", "--only=--color,web", "--exclude=-worker"]))
      .toMatchObject({ only: ["-api", "--color", "web"], exclude: ["-worker"] });
  });

  it("prints the real package version", async () => {
    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version: string;
    };
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await expect(main(["--version"])).resolves.toBe(0);
      expect(log).toHaveBeenCalledWith(packageJson.version);
    } finally {
      log.mockRestore();
    }
  });
});
