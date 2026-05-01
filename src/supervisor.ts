import { existsSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { loadConfig } from "./config.js";
import { ControlServer } from "./control-server.js";
import {
  readVerifiedSupervisorState,
  removeSupervisorState,
  sendControlCommand,
  writeSupervisorState
} from "./control-client.js";
import { PrefixedLogger } from "./logger.js";
import { ProcessManager } from "./process-manager.js";
import type {
  ColorMode,
  ControlCommand,
  LoadedConfig,
  SupervisorStateFile,
  SupervisorStatus
} from "./types.js";

export interface UpOptions {
  cwd: string;
  colorMode: ColorMode;
  timestamps: boolean;
  configPath?: string;
  procfilePath?: string;
  positionalPath?: string;
}

export type CheckOptions = Omit<UpOptions, "colorMode" | "timestamps">;

export async function runUp(options: UpOptions): Promise<number> {
  const config = loadConfig({
    cwd: options.cwd,
    configPath: options.configPath,
    procfilePath: options.procfilePath,
    positionalPath: options.positionalPath
  });

  const existing = await readVerifiedSupervisorState(config.projectRoot);
  if (existing) {
    throw new Error(`prwr supervisor is already running for this project (pid ${existing.supervisorPid}).`);
  }

  console.log(`prwr loaded ${path.relative(options.cwd, config.configPath) || config.configPath}`);
  console.log(`prwr starting ${config.processes.length} process${config.processes.length === 1 ? "" : "es"}`);
  console.log("Use another terminal: prwr restart <name>, prwr stop <name>, prwr down");

  return runSupervisor(config, options.colorMode, options.timestamps);
}

export async function sendProjectCommand(
  cwd: string,
  command: ControlCommand
): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  return sendControlCommand(cwd, command);
}

export async function runCheck(options: CheckOptions): Promise<number> {
  const config = loadConfig({
    cwd: options.cwd,
    configPath: options.configPath,
    procfilePath: options.procfilePath,
    positionalPath: options.positionalPath
  });

  validateProcessCwds(config);
  console.log(`prwr config ok: ${path.relative(options.cwd, config.configPath) || config.configPath}`);
  console.log(`prwr processes: ${config.processes.map((processConfig) => processConfig.name).join(", ")}`);

  const state = await readVerifiedSupervisorState(config.projectRoot);
  if (state) {
    console.log(`prwr supervisor running pid=${state.supervisorPid} startedAt=${state.startedAt}`);
  } else {
    console.log("prwr supervisor not running");
  }

  return 0;
}

async function runSupervisor(
  config: LoadedConfig,
  colorMode: ColorMode,
  timestamps: boolean
): Promise<number> {
  let shutdownPromise: Promise<void> | null = null;
  let resolveExit: (code: number) => void = () => undefined;
  const exitPromise = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });

  const logger = new PrefixedLogger({
    names: config.processes.map((processConfig) => processConfig.name),
    colorMode,
    timestamps
  });

  let state: SupervisorStateFile;
  let server: ControlServer;
  const token = randomBytes(32).toString("base64url");

  const shutdown = async (exitCode: number) => {
    if (shutdownPromise) {
      return shutdownPromise;
    }

    shutdownPromise = (async () => {
      const allStopped = await manager.stopAll();
      if (!allStopped) {
        console.error("prwr shutdown did not complete because one or more processes are still running.");
        shutdownPromise = null;
        return;
      }

      await server.close().catch(() => undefined);
      removeSupervisorState(config.projectRoot);
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      resolveExit(exitCode);
    })();

    return shutdownPromise;
  };

  const manager = new ProcessManager(config, {
    logger,
    onFatalExit: (name) => {
      logger.lifecycle(name, "killOnExit triggered; stopping all processes", "stderr");
      void shutdown(1);
    }
  });

  server = new ControlServer(async (command) => {
    switch (command.type) {
      case "identity":
        return publicSupervisorState(state);
      case "status":
        return {
          supervisor: publicSupervisorState(state),
          processes: manager.getStatus()
        } satisfies SupervisorStatus;
      case "restart":
        return manager.restart(command.name);
      case "stop":
        return manager.stop(command.name);
      case "start":
        return manager.start(command.name);
      case "send":
        return manager.send(command.name, command.text);
      case "down":
        setTimeout(() => {
          void shutdown(0);
        }, 0);
        return { message: "stopping prwr supervisor" };
      default:
        throw new Error("Unknown control command.");
    }
  }, { token });

  const port = await server.listen();
  state = {
    supervisorPid: process.pid,
    projectRoot: config.projectRoot,
    configPath: config.configPath,
    port,
    token,
    startedAt: new Date().toISOString()
  };

  writeSupervisorState(state);

  const onSignal = () => {
    void shutdown(0);
  };

  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  await manager.startAll();
  return exitPromise;
}

function validateProcessCwds(config: LoadedConfig): void {
  for (const processConfig of config.processes) {
    if (!existsSync(processConfig.cwd)) {
      throw new Error(`Invalid process "${processConfig.name}": cwd does not exist: ${processConfig.cwd}`);
    }

    if (!statSync(processConfig.cwd).isDirectory()) {
      throw new Error(`Invalid process "${processConfig.name}": cwd is not a directory: ${processConfig.cwd}`);
    }
  }
}

function publicSupervisorState(state: SupervisorStateFile): Omit<SupervisorStateFile, "token"> {
  return {
    supervisorPid: state.supervisorPid,
    projectRoot: state.projectRoot,
    configPath: state.configPath,
    port: state.port,
    startedAt: state.startedAt
  };
}
