import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { stateFilePath } from "../src/control-client.js";
import { isPidAlive } from "../src/kill-tree.js";
import type { SupervisorStateFile, SupervisorStatus } from "../src/types.js";
import { CliTestHarness, within } from "./helpers/cli-process.js";
import { nodeCommand, waitFor } from "./helpers/process-manager.js";
import { unusedPort } from "./helpers/readiness.js";

function databaseCommand(): string {
  return nodeCommand([
    "const fs = require('node:fs'); const http = require('node:http'); const { spawn } = require('node:child_process');",
    "const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    "fs.appendFileSync('../pids.txt', String(grandchild.pid) + String.fromCharCode(10));",
    "fs.writeFileSync('db-env.json', JSON.stringify({ secret: process.env.PRWR_INTEGRATION_SECRET, cwd: process.cwd() }));",
    "process.stderr.write('stderr-final-partial');",
    "process.stdin.on('data', (text) => console.log('input:' + text.toString().trim()));",
    "const server = http.createServer((_, response) => { response.writeHead(fs.existsSync('allow-ready') ? 204 : 503).end(); });",
    "server.listen(Number(process.env.PRWR_INTEGRATION_PORT), '127.0.0.1', () => console.log('db-listening'));"
  ].join(" "));
}

function dependentCommand(): string {
  return nodeCommand([
    "const fs = require('node:fs'); const { spawn } = require('node:child_process');",
    "const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    "fs.appendFileSync('pids.txt', String(grandchild.pid) + String.fromCharCode(10));",
    "fs.writeFileSync('dependent-started', process.env.PRWR_INTEGRATION_SECRET);",
    "console.log('web-started'); setInterval(() => {}, 1000);"
  ].join(" "));
}

function makeFixture(harness: CliTestHarness, port: number) {
  const project = path.join(harness.root, "project");
  const service = path.join(project, "service");
  mkdirSync(service, { recursive: true });
  const secret = "fixture-env-value";
  writeFileSync(path.join(project, ".env"), `PRWR_INTEGRATION_SECRET=${secret}\nPRWR_INTEGRATION_PORT=${port}\n`);
  const configPath = path.join(project, ".prwr.yml");
  writeFileSync(configPath, YAML.stringify({
    envFile: ".env",
    processes: {
      web: { command: dependentCommand(), dependsOn: ["db"] },
      db: {
        command: databaseCommand(), cwd: "./service", stdin: true,
        readyWhen: { type: "http", url: `http://127.0.0.1:${port}/health`, timeoutMs: 20000, intervalMs: 20 }
      },
      excluded: { command: nodeCommand("require('node:fs').writeFileSync('excluded-started', 'started'); setInterval(() => {}, 1000)") }
    }
  }));
  return { project, service, secret, configPath };
}

function descendants(project: string): number[] {
  const pidFile = path.join(project, "pids.txt");
  return existsSync(pidFile) ? readFileSync(pidFile, "utf8").trim().split(/\r?\n/).filter(Boolean).map(Number) : [];
}

async function status(harness: CliTestHarness, project: string): Promise<SupervisorStatus> {
  const result = await harness.run(project, ["status", "--json"]);
  expect(result.code, result.stderr).toBe(0);
  expect(result.stderr).toBe("");
  const parsed = JSON.parse(result.stdout) as SupervisorStatus;
  harness.trackTree(parsed.supervisor.supervisorPid);
  for (const process of parsed.processes) harness.trackTree(process.pid);
  return parsed;
}

describe("source CLI feature integration", () => {
  it("runs selected dependency trees with env files, readiness, JSON status, input, replay and full cleanup", async () => {
    const harness = new CliTestHarness({ PRWR_INTEGRATION_SECRET: undefined, PRWR_INTEGRATION_PORT: undefined });
    const fixture = makeFixture(harness, await unusedPort());
    const supervisor = harness.start(harness.root, ["up", "--config", fixture.configPath, "--only", "web", "--exclude", "excluded", "--no-color"]);
    const observedPids = new Set<number>();
    try {
      await waitFor(() => {
        if (supervisor.closed) throw new Error(`Supervisor exited before database startup.\n${supervisor.stdout}\n${supervisor.stderr}`);
        return supervisor.stdout.includes("db-listening");
      }, 10000).catch((error) => {
        throw new Error(`${String(error)}\n${supervisor.stdout}\n${supervisor.stderr}`);
      });
      expect(existsSync(path.join(fixture.project, "dependent-started"))).toBe(false);
      const pending = await status(harness, fixture.project);
      expect(pending.processes.map(({ name, state }) => ({ name, state }))).toEqual([
        { name: "db", state: "starting" }, { name: "web", state: "stopped" }
      ]);
      expect(JSON.parse(readFileSync(path.join(fixture.service, "db-env.json"), "utf8")))
        .toEqual({ secret: fixture.secret, cwd: fixture.service });

      writeFileSync(path.join(fixture.service, "allow-ready"), "ready");
      await waitFor(() => supervisor.stdout.includes("web-started"), 10000);
      expect(readFileSync(path.join(fixture.project, "dependent-started"), "utf8")).toBe(fixture.secret);
      expect(existsSync(path.join(fixture.project, "excluded-started"))).toBe(false);
      const ready = await status(harness, fixture.project);
      expect(ready.processes.map(({ name, state }) => ({ name, state }))).toEqual([
        { name: "db", state: "running" }, { name: "web", state: "running" }
      ]);
      const runtime = JSON.parse(readFileSync(stateFilePath(fixture.project), "utf8")) as SupervisorStateFile;
      expect(ready.supervisor).not.toHaveProperty("token");
      expect(JSON.stringify(ready)).not.toContain(runtime.token);
      expect(JSON.stringify(ready)).not.toContain(fixture.secret);
      for (const process of ready.processes) {
        expect(process).not.toHaveProperty("env");
        expect(process).not.toHaveProperty("config");
        expect(process.pid).toBeGreaterThan(0);
        observedPids.add(process.pid!);
      }
      for (const pid of descendants(fixture.project)) { observedPids.add(pid); harness.trackDescendant(pid); }
      expect(descendants(fixture.project)).toHaveLength(2);
      expect(descendants(fixture.project).every((pid) => Number.isInteger(pid) && pid > 0 && isPidAlive(pid))).toBe(true);

      expect((await harness.run(fixture.project, ["send", "db", "ping"])).code).toBe(0);
      await waitFor(() => supervisor.stdout.includes("input:ping"));
      const tail = await harness.run(fixture.project, ["logs", "db", "--tail", "1", "--no-color"]);
      expect(tail.code, tail.stderr).toBe(0);
      expect(tail.stdout).toMatch(/^\d{4}-\d{2}-\d{2}T\S+ db \| input:ping\r?\n$/);
      expect(tail.stderr).toBe("");
      expect(await harness.run(fixture.project, ["logs", "db", "--tail", "1", "--no-color"])).toEqual(tail);
      const empty = await harness.run(fixture.project, ["logs", "db", "--tail", "0", "--no-color"]);
      expect(empty).toMatchObject({ code: 0, stdout: "", stderr: "" });

      const firstGrandchild = descendants(fixture.project)[0]!;
      expect((await harness.run(fixture.project, ["restart", "db"])).code).toBe(0);
      const restarted = await status(harness, fixture.project);
      expect(restarted.processes[0]).toMatchObject({ name: "db", state: "running", restartCount: 1 });
      expect(restarted.processes[0]!.pid).not.toBe(ready.processes[0]!.pid);
      expect(isPidAlive(firstGrandchild)).toBe(false);
      observedPids.add(restarted.processes[0]!.pid!);
      for (const pid of descendants(fixture.project)) { observedPids.add(pid); harness.trackDescendant(pid); }
      expect(descendants(fixture.project)).toHaveLength(3);
      expect(descendants(fixture.project).slice(1).every((pid) => Number.isInteger(pid) && pid > 0 && isPidAlive(pid))).toBe(true);
      const replay = await harness.run(fixture.project, ["logs", "db", "--tail", "1000", "--no-color"]);
      expect(replay.code).toBe(0);
      expect(replay.stderr).toMatch(/\d{4}-\d{2}-\d{2}T\S+ db \| stderr-final-partial\r?\n/);
      expect(replay.stdout).toContain("input:ping");

      expect((await harness.run(fixture.project, ["down"])).code).toBe(0);
      expect((await within(supervisor.completion, 10000, "Supervisor did not finish after down.")).code).toBe(0);
      expect(existsSync(stateFilePath(fixture.project))).toBe(false);
      expect([...observedPids].filter((pid) => isPidAlive(pid))).toEqual([]);
      const stopped = await harness.run(fixture.project, ["status", "--json"]);
      expect(stopped).toMatchObject({ code: 1, stderr: "" });
      expect(JSON.parse(stopped.stdout)).toEqual({ ok: false, error: "prwr supervisor is not running for this project." });
    } finally {
      for (const pid of descendants(fixture.project)) harness.trackDescendant(pid);
      await harness.cleanup();
    }
  }, 30000);
});
