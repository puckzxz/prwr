import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { findConfig, loadConfig } from "../src/config.js";

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "prwr-config-"));
}

describe("config loading", () => {
  it("loads .prwr.yml processes", () => {
    const dir = tempDir();
    mkdirSync(path.join(dir, "apps", "gui"), { recursive: true });
    writeFileSync(
      path.join(dir, ".prwr.yml"),
      `processes:
  gui:
    command: npm run dev
    cwd: ./apps/gui
    env:
      PORT: 3000
    restart: on-failure
    killOnExit: true
    stdin: true
    startupDelayMs: 10
    restartBackoffMs: 1000
    restartBackoffMaxMs: 30000
    restartBackoffResetMs: 60000
    restartMaxAttempts: 3
`
    );

    const config = loadConfig({ cwd: dir });
    expect(config.configPath).toBe(path.join(dir, ".prwr.yml"));
    expect(config.processes[0]).toMatchObject({
      name: "gui",
      command: "npm run dev",
      cwd: path.join(dir, "apps", "gui"),
      env: { PORT: "3000" },
      restart: "on-failure",
      killOnExit: true,
      stdin: true,
      startupDelayMs: 10,
      restartBackoffMs: 1000,
      restartBackoffMaxMs: 30000,
      restartBackoffResetMs: 60000,
      restartMaxAttempts: 3
    });
  });

  it("uses search precedence", () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, "Procfile"), "web: npm start\n");
    writeFileSync(path.join(dir, ".prwr.yaml"), "processes:\n  api:\n    command: node api.js\n");

    expect(findConfig(dir)).toBe(path.join(dir, ".prwr.yaml"));
  });

  it("loads explicit Procfile", () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, "Procfile.dev"), "web: npm start\n");

    const config = loadConfig({ cwd: dir, positionalPath: "./Procfile.dev" });
    expect(config.sourceType).toBe("procfile");
    expect(config.processes[0]?.name).toBe("web");
  });

  it("resolves process cwd relative to the config file", () => {
    const shellDir = tempDir();
    const projectDir = tempDir();
    mkdirSync(path.join(projectDir, "apps", "api"), { recursive: true });
    const configPath = path.join(projectDir, ".prwr.yml");
    writeFileSync(
      configPath,
      `processes:
  api:
    command: npm run dev
    cwd: ./apps/api
`
    );

    const config = loadConfig({ cwd: shellDir, configPath });

    expect(config.projectRoot).toBe(projectDir);
    expect(config.processes[0]?.cwd).toBe(path.join(projectDir, "apps", "api"));
  });

  it("rejects invalid process config", () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, ".prwr.yml"), "processes:\n  web:\n    cwd: ./app\n");

    expect(() => loadConfig({ cwd: dir })).toThrow(/command is required/);
  });

  it("rejects unknown top-level yaml fields", () => {
    const dir = tempDir();
    writeFileSync(
      path.join(dir, ".prwr.yml"),
      "version: 1\nprocesses:\n  web:\n    command: npm start\n"
    );

    expect(() => loadConfig({ cwd: dir })).toThrow(/unknown top-level field "version"/);
  });

  it("rejects unknown process fields", () => {
    const dir = tempDir();
    writeFileSync(
      path.join(dir, ".prwr.yml"),
      "processes:\n  web:\n    command: npm start\n    killOnexit: true\n"
    );

    expect(() => loadConfig({ cwd: dir })).toThrow(/unknown process "web" field "killOnexit"/);
  });

  it("rejects invalid stdin and restart values", () => {
    const dir = tempDir();
    writeFileSync(
      path.join(dir, ".prwr.yml"),
      "processes:\n  web:\n    command: npm start\n    stdin: yes\n"
    );

    expect(() => loadConfig({ cwd: dir })).toThrow(/stdin must be a boolean/);

    const otherDir = tempDir();
    writeFileSync(
      path.join(otherDir, ".prwr.yml"),
      "processes:\n  web:\n    command: npm start\n    restartMaxAttempts: 1.5\n"
    );

    expect(() => loadConfig({ cwd: otherDir })).toThrow(/restartMaxAttempts must be a non-negative integer/);
  });

  it("shares defaults between YAML shorthand and Procfile entries", () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, ".prwr.yml"), "processes:\n  api: node api.js\n");
    writeFileSync(path.join(dir, "Procfile"), "api: node api.js\n");
    expect(loadConfig({ cwd: dir, configPath: ".prwr.yml" }).processes)
      .toEqual(loadConfig({ cwd: dir, procfilePath: "Procfile" }).processes);
  });

  it("resolves shared and per-process environment files from the config directory with defined precedence", () => {
    const shellDir = tempDir();
    const projectDir = tempDir();
    mkdirSync(path.join(projectDir, "apps", "api"), { recursive: true });
    writeFileSync(path.join(projectDir, "shared.env"), "PRWR_FILE_LAYER=shared\nPRWR_FILE_PARENT=file\nPRWR_FILE_INLINE=file\nPRWR_SHARED_ONLY=shared\n");
    writeFileSync(path.join(projectDir, "shared.local.env"), "PRWR_FILE_LAYER=shared-local\n");
    writeFileSync(path.join(projectDir, "api.env"), "PRWR_FILE_LAYER=process\nPRWR_PROCESS_ONLY=process\n");
    writeFileSync(path.join(projectDir, "api.local.env"), "PRWR_FILE_LAYER=process-local\n");
    writeFileSync(path.join(projectDir, ".prwr.yml"), `envFile: [shared.env, shared.local.env]
processes:
  api:
    command: node api.js
    cwd: apps/api
    envFile: [api.env, api.local.env]
    env:
      PRWR_FILE_INLINE: inline
      PRWR_NUMBER: 123
      PRWR_BOOLEAN: false
  worker: node worker.js
`);
    vi.stubEnv("PRWR_FILE_PARENT", "parent");
    vi.stubEnv("PRWR_FILE_INLINE", "parent");
    const before = { ...process.env };
    try {
      const loaded = loadConfig({ cwd: shellDir, configPath: path.join(projectDir, ".prwr.yml") });
      expect(loaded.processes[0]?.env).toEqual({
        PRWR_FILE_LAYER: "process-local", PRWR_PROCESS_ONLY: "process", PRWR_SHARED_ONLY: "shared",
        PRWR_FILE_INLINE: "inline", PRWR_NUMBER: "123", PRWR_BOOLEAN: "false"
      });
      expect(loaded.processes[1]?.env).toEqual({ PRWR_FILE_LAYER: "shared-local", PRWR_SHARED_ONLY: "shared" });
      expect(process.env).toEqual(before);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("normalizes readiness and string or list dependencies from YAML", () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, ".prwr.yml"), `processes:
  api:
    command: node api.js
    dependsOn: [database, database]
    readyWhen:
      type: http
      url: http://localhost:3000/health
  worker:
    command: node worker.js
    dependsOn: api
  database:
    command: node database.js
    readyWhen:
      type: tcp
      port: 5432
`);
    const loaded = loadConfig({ cwd: dir });
    expect(loaded.processes[0]).toMatchObject({
      dependsOn: ["database"], readyWhen: { type: "http", timeoutMs: 10000, intervalMs: 100 }
    });
    expect(loaded.processes[1]?.dependsOn).toEqual(["api"]);
    expect(loaded.processes[2]?.readyWhen).toEqual({
      type: "tcp", host: "127.0.0.1", port: 5432, timeoutMs: 10000, intervalMs: 100
    });
  });

  it.each([1, {}, ["api", 1], [""], "bad name"].map((value) => ({ value })))
    ("rejects malformed YAML dependencies: $value", ({ value }) => {
      const dir = tempDir();
      writeFileSync(path.join(dir, ".prwr.yml"), `processes:\n  api:\n    command: node api.js\n    dependsOn: ${JSON.stringify(value)}\n`);
      expect(() => loadConfig({ cwd: dir })).toThrow(/dependsOn must be|may only contain/);
    });

  it("rejects broken dependency graphs while loading a config", () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, ".prwr.yml"), "processes:\n  api:\n    command: node api.js\n    dependsOn: missing\n");
    expect(() => loadConfig({ cwd: dir })).toThrow(/Unknown dependency "missing"/);
    writeFileSync(path.join(dir, ".prwr.yml"), "processes:\n  api:\n    command: node api.js\n    dependsOn: worker\n  worker:\n    command: node worker.js\n    dependsOn: api\n");
    expect(() => loadConfig({ cwd: dir })).toThrow(/Dependency cycle: api -> worker -> api/);
  });
});
