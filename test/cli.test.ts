import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { main, parseCliArgs } from "../src/cli.js";

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
