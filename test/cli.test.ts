import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../src/cli.js";

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
});
