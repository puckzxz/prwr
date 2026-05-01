import { describe, expect, it } from "vitest";
import { parseProcfile } from "../src/procfile.js";

describe("parseProcfile", () => {
  it("parses named commands", () => {
    expect(parseProcfile("gui: npm run dev\nbackend: node server.js\n")).toEqual([
      { name: "gui", command: "npm run dev", line: 1 },
      { name: "backend", command: "node server.js", line: 2 }
    ]);
  });

  it("ignores comments and blank lines", () => {
    expect(parseProcfile("# comment\n\nweb: npm start\n")).toEqual([
      { name: "web", command: "npm start", line: 3 }
    ]);
  });

  it("rejects invalid lines", () => {
    expect(() => parseProcfile("web npm start\n")).toThrow(/expected "name: command"/);
  });
});
