import path from "node:path";
import type { ProcessStatus, PublicSupervisorState, SupervisorIdentity, SupervisorStateFile, SupervisorStatus } from "../../src/types.js";

export function stateFor(dir: string, port: number, token: string): SupervisorStateFile {
  return {
    supervisorPid: process.pid, projectRoot: dir, configPath: path.join(dir, ".prwr.yml"),
    port, token, startedAt: "2026-10-29T12:34:56.000Z"
  };
}

export function identityFor(state: SupervisorStateFile): SupervisorIdentity {
  const { supervisorPid, projectRoot, configPath, startedAt } = state;
  return { supervisorPid, projectRoot, configPath, startedAt };
}

export function processStatusFor(name: string, overrides: Partial<ProcessStatus> = {}): ProcessStatus {
  return {
    name, state: "running", pid: 101, command: "node service.js", cwd: process.cwd(),
    lastExitCode: null, lastSignal: null, restartCount: 0, lastError: null, ...overrides
  };
}

export function statusFor(
  processes = [processStatusFor("api")], overrides: Partial<PublicSupervisorState> = {}
): SupervisorStatus {
  const state = stateFor(process.cwd(), 9000, "fixture-token");
  return { supervisor: { ...identityFor(state), port: state.port, ...overrides }, processes };
}
