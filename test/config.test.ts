import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
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
});
