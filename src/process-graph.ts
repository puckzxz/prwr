import type { LoadedConfig, ProcessConfig, ProcessSelection } from "./types.js";

export function orderedProcesses(processes: ProcessConfig[]): ProcessConfig[] {
  const byName = new Map(processes.map((process) => [process.name, process]));
  const ordered: ProcessConfig[] = [];
  const visited = new Set<string>();
  const visiting: string[] = [];
  function visit(name: string): void {
    if (visited.has(name)) return;
    if (visiting.includes(name)) {
      throw new Error(`Dependency cycle: ${[...visiting.slice(visiting.indexOf(name)), name].join(" -> ")}.`);
    }
    const process = byName.get(name);
    if (!process) {
      throw new Error(`Unknown dependency "${name}" required by "${visiting.at(-1)}".`);
    }
    visiting.push(name);
    for (const dependency of process.dependsOn) visit(dependency);
    visiting.pop();
    visited.add(name);
    ordered.push(process);
  }
  for (const process of processes) visit(process.name);
  return ordered;
}

export function selectProcesses(config: LoadedConfig, selection: ProcessSelection): LoadedConfig {
  const ordered = orderedProcesses(config.processes);
  const byName = new Map(config.processes.map((process) => [process.name, process]));
  const excluded = new Set(selection.exclude ?? []);
  const roots = selection.only ?? config.processes.map((process) => process.name);
  for (const name of [...roots, ...excluded]) {
    if (!byName.has(name)) {
      throw new Error(`Unknown process "${name}". Available processes: ${[...byName.keys()].join(", ")}`);
    }
  }
  for (const name of selection.only ?? []) {
    if (excluded.has(name)) {
      throw new Error(`Cannot both select and exclude "${name}".`);
    }
  }
  const selected = new Set<string>();
  function include(name: string, requiredBy?: string): void {
    if (excluded.has(name)) {
      if (requiredBy) throw new Error(`Cannot exclude "${name}": required by "${requiredBy}".`);
      return;
    }
    if (selected.has(name)) return;
    selected.add(name);
    for (const dependency of byName.get(name)!.dependsOn) include(dependency, name);
  }
  for (const name of roots) include(name);
  if (!selected.size) throw new Error("Process selection is empty.");
  return { ...config, processes: ordered.filter((process) => selected.has(process.name)) };
}
