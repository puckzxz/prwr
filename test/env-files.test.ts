import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { childEnvironment, loadEnvFiles, mergeEnv, resolveEnv } from "../src/env-files.js";

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "prwr-env-"));
}

describe("environment files", () => {
  it("parses quoted values, comments, empty values, and multiline values without expansion", () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, ".env"), [
      "# comment",
      "BASIC= basic # inline comment",
      'QUOTED=" value#hash "',
      "EMPTY=",
      'MULTILINE="first\\nsecond"',
      'LITERAL="${BASIC}"'
    ].join("\n"));

    expect(loadEnvFiles(".env", dir, "top-level")).toEqual({
      BASIC: "basic",
      QUOTED: " value#hash ",
      EMPTY: "",
      MULTILINE: "first\nsecond",
      LITERAL: "${BASIC}"
    });
  });

  it("merges files in order with the last value winning", () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, ".env"), "SHARED=first\nFIRST=first\n");
    writeFileSync(path.join(dir, ".env.local"), "SHARED=second\nSECOND=second\n");

    expect(loadEnvFiles([".env", ".env.local"], dir, "top-level")).toEqual({
      SHARED: "second", FIRST: "first", SECOND: "second"
    });
  });

  it("does not discover a file unless configured or mutate or print the parent environment", () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, ".env"), "PRWR_FILE_ONLY=private-value\n");
    const before = { ...process.env };
    const log = vi.spyOn(console, "log");
    const error = vi.spyOn(console, "error");
    try {
      expect(loadEnvFiles(undefined, dir, "top-level")).toEqual({});
      expect(loadEnvFiles(".env", dir, "top-level")).toEqual({ PRWR_FILE_ONLY: "private-value" });
      expect(process.env).toEqual(before);
      expect(log).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  it.each(["", [], [""], ["   "], [".env", 4], 4, {}].map((value) => ({ value })))
    ("rejects invalid file declarations: $value", ({ value }) => {
    expect(() => loadEnvFiles(value, tempDir(), "top-level")).toThrow(/envFile must be a path or a non-empty list/);
  });

  it("reports unreadable files with context", () => {
    const dir = tempDir();
    expect(() => loadEnvFiles("missing.env", dir, 'process "api"')).toThrow(/process "api": cannot read envFile.*missing\.env \(ENOENT\)/);
  });
});

describe("environment precedence", () => {
  it("lets inherited variables override files and inline values override inherited variables", () => {
    const inherited = { SHARED: "parent", EMPTY: "", UNDEFINED: undefined };
    const fileEnv = { SHARED: "file", EMPTY: "file", UNDEFINED: "file", FILE_ONLY: "file" };

    expect(resolveEnv(fileEnv, { SHARED: "inline", INLINE_ONLY: "inline" }, inherited, "linux"))
      .toEqual({ SHARED: "inline", UNDEFINED: "file", FILE_ONLY: "file", INLINE_ONLY: "inline" });
    expect(fileEnv.SHARED).toBe("file");
    expect(inherited.SHARED).toBe("parent");
  });

  it("treats Windows keys case-insensitively across every precedence layer", () => {
    const inherited = { Path: "parent", PRWR: "parent", Force_Color: "0" };
    const overrides = resolveEnv({ PATH: "file", PrWr: "file" }, { path: "inline" }, inherited, "win32");
    const child = childEnvironment(overrides, inherited, "win32");

    expect(child).toEqual({ path: "inline", PRWR: "parent", Force_Color: "0" });
    expect(Object.keys(child).filter((key) => key.toUpperCase() === "PATH")).toHaveLength(1);
  });

  it("preserves case-sensitive variables on other platforms", () => {
    const overrides = resolveEnv({ PATH: "file" }, { path: "inline" }, { Path: "parent" }, "linux");
    expect(childEnvironment(overrides, { Path: "parent" }, "linux")).toEqual({
      PATH: "file", path: "inline", Path: "parent", FORCE_COLOR: "1"
    });
  });

  it("deduplicates file aliases and inherited aliases before spawning on Windows", () => {
    expect(resolveEnv({ PRWR: "first", prwr: "last" }, {}, {}, "win32")).toEqual({ prwr: "last" });
    expect(childEnvironment({}, { PATH: "first", Path: "last" }, "win32"))
      .toEqual({ Path: "last", FORCE_COLOR: "1" });
  });

  it("preserves explicit FORCE_COLOR settings and leaves input objects untouched", () => {
    const inherited = { Path: "parent" };
    const overrides = { PATH: "inline", force_color: "0" };
    expect(childEnvironment(overrides, inherited, "win32")).toEqual({ PATH: "inline", force_color: "0" });
    expect(inherited).toEqual({ Path: "parent" });
    expect(overrides).toEqual({ PATH: "inline", force_color: "0" });
  });

  it("treats prototype-shaped names as ordinary environment keys", () => {
    const target: NodeJS.ProcessEnv = {};
    mergeEnv(target, JSON.parse('{"__proto__":"literal","constructor":"value"}') as NodeJS.ProcessEnv, "linux");
    expect(Object.hasOwn(target, "__proto__")).toBe(true);
    expect(target.__proto__).toBe("literal");
    expect(Object.getPrototypeOf(target)).toBe(Object.prototype);
  });

  it("passes the resolved precedence to a real Node child", () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, ".env"), "PRWR_CHILD_VALUE=file\nPRWR_CHILD_DEFAULT=file-default\n");
    const inherited = { ...process.env, PRWR_CHILD_VALUE: "parent" };
    const inlineKey = process.platform === "win32" ? "prwr_child_value" : "PRWR_CHILD_VALUE";
    const overrides = resolveEnv(loadEnvFiles(".env", dir, "test"), { [inlineKey]: "inline" }, inherited);
    const result = spawnSync(process.execPath, ["-e", "process.stdout.write(JSON.stringify([process.env.PRWR_CHILD_VALUE, process.env.PRWR_CHILD_DEFAULT]))"], {
      env: childEnvironment(overrides, inherited), encoding: "utf8", timeout: 5000, windowsHide: true
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(["inline", "file-default"]);
  });
});
