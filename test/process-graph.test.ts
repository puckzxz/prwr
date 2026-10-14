import { describe, expect, it } from "vitest";
import { normalizeProcessConfig } from "../src/process-config.js";
import { orderedProcesses, selectProcesses } from "../src/process-graph.js";
import type { LoadedConfig, ProcessConfig } from "../src/types.js";

function processConfig(name: string, dependsOn: string[] = []): ProcessConfig {
  return normalizeProcessConfig(name, { command: "node -e \"setInterval(() => {}, 1000)\"", dependsOn }, ".");
}

function config(processes: ProcessConfig[]): LoadedConfig {
  return { configPath: ".prwr.yml", configDir: ".", projectRoot: ".", sourceType: "yaml", processes };
}

function names(processes: ProcessConfig[]): string[] {
  return processes.map((process) => process.name);
}

describe("dependency graphs", () => {
  it("orders dependencies first while preserving declaration order between independent processes", () => {
    const processes = [processConfig("api", ["database"]), processConfig("worker", ["database"]), processConfig("database"), processConfig("web")];
    expect(names(orderedProcesses(processes))).toEqual(["database", "api", "worker", "web"]);
    expect(names(processes)).toEqual(["api", "worker", "database", "web"]);
  });

  it("rejects missing dependencies", () => {
    expect(() => orderedProcesses([processConfig("api", ["database"])]))
      .toThrow('Unknown dependency "database" required by "api".');
  });

  it.each([
    { processes: [processConfig("api", ["api"])] },
    { processes: [processConfig("api", ["worker"]), processConfig("worker", ["database"]), processConfig("database", ["api"])] }
  ])("rejects cycles with their path", ({ processes }) => {
    expect(() => orderedProcesses(processes)).toThrow(/Dependency cycle: api -> (worker -> database -> )?api/);
  });
});

describe("process selection", () => {
  const processes = [
    processConfig("web", ["api"]), processConfig("worker", ["database"]), processConfig("api", ["database"]), processConfig("database"), processConfig("standalone")
  ];

  it("includes the full dependency closure once for explicitly selected processes", () => {
    const loaded = config(processes);
    expect(names(selectProcesses(loaded, { only: ["web", "worker", "web"] }).processes))
      .toEqual(["database", "api", "web", "worker"]);
    expect(loaded.processes).toBe(processes);
  });

  it("excludes independent processes and allows omitting their unused dependencies", () => {
    expect(names(selectProcesses(config(processes), { exclude: ["web", "worker", "api", "database"] }).processes))
      .toEqual(["standalone"]);
    expect(names(selectProcesses(config(processes), { only: ["standalone"], exclude: ["database"] }).processes))
      .toEqual(["standalone"]);
  });

  it("rejects exclusion of a dependency", () => {
    expect(() => selectProcesses(config(processes), { only: ["web"], exclude: ["database"] }))
      .toThrow('Cannot exclude "database": required by "api".');
    expect(() => selectProcesses(config(processes), { exclude: ["api"] }))
      .toThrow('Cannot exclude "api": required by "web".');
  });

  it("rejects overlap between explicit selection and exclusion", () => {
    expect(() => selectProcesses(config(processes), { only: ["standalone", "web"], exclude: ["standalone"] }))
      .toThrow('Cannot both select and exclude "standalone".');
  });

  it.each([{ only: ["typo"] }, { exclude: ["typo"] }])("rejects unknown selectors: %j", (selection) => {
    expect(() => selectProcesses(config(processes), selection)).toThrow(/Unknown process "typo".*Available processes/);
  });

  it.each([{ only: [] }, { exclude: processes.map((process) => process.name) }])("rejects empty selections: %j", (selection) => {
    expect(() => selectProcesses(config(processes), selection)).toThrow("Process selection is empty.");
  });

  it("validates the entire graph even when invalid processes are unselected", () => {
    const invalid = [processConfig("standalone"), processConfig("api", ["missing"])];
    expect(() => selectProcesses(config(invalid), { only: ["standalone"] })).toThrow(/Unknown dependency "missing"/);
    const cyclic = [processConfig("standalone"), processConfig("api", ["api"])];
    expect(() => selectProcesses(config(cyclic), { only: ["standalone"] })).toThrow(/Dependency cycle/);
  });
});
