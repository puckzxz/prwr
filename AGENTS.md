# AGENTS.md

## Project

`prwr` is Process Wrangler: a Windows-first local process supervisor for development commands.

It starts multiple long-running commands, prefixes their output, exposes local control commands, and shuts down full process trees. It intentionally does not use tmux, panes, curses, or a TUI.

## Commands

Use plain `pnpm` for normal development:

```powershell
pnpm install
pnpm run lint
pnpm run build
pnpm test
pnpm run pack:check
```

If `pnpm` is unavailable in an automation environment, configure that environment to provide pnpm rather than changing project scripts.

## Design Constraints

- Windows process-tree correctness is a core requirement.
- Windows shutdown must kill the whole tree with `taskkill /PID <pid> /T /F` or behaviorally equivalent logic.
- `Ctrl+C`, `prwr down`, and `prwr restart <name>` must not leave `npm`, `node`, `python`, or similar child/grandchild processes running.
- `prwr restart <name>` must stop the old process tree before spawning the replacement.
- Shutdown should be idempotent and should not exit before process-tree cleanup completes.
- Config-relative paths must resolve relative to the config file directory, not the current shell by accident.
- stdout and stderr buffering must flush final partial lines on process exit.
- Tests should use portable `node -e` commands instead of bash-specific shell syntax.
- Keep the CLI simple: no TUI, no interactive child stdin, no panes.

## Ownership And Contracts

- `src/types.ts` owns shared process, readiness, control, status, and log shapes. Keep command registries and validators exhaustive against those unions rather than maintaining independent command lists.
- `src/config.ts` selects and loads config; `process-config.ts` normalizes shared YAML and Procfile defaults. `env-files.ts` owns file precedence and child environment merging; `process-graph.ts` owns dependency validation, ordering, and selection. Keep these boundaries shared by startup and static checks.
- `src/process-manager.ts` owns lifecycle coordination. Its launch, stop, I/O, restart-policy, and readiness siblings own their focused behavior. Startup waits must be abortable, and readiness failures must complete process-tree cleanup before retries.
- `src/cli-args.ts` owns argument parsing and `cli-output.ts` owns rendering. `control-protocol.ts`, `control-client.ts`, and `control-server.ts` own authenticated command exchange and supervisor identity checks. Transport failures must preserve state for a live supervisor; public status must exclude tokens and environment mappings.
- `src/process-wait.ts` owns client-side startup waits using authenticated status snapshots. Its total deadline and cancellation must cover identity probes, control requests, and polling; waiting must not mutate process lifecycle. Explicit control targets must match the supervisor's config path without reloading config or environment files.
- `src/logger.ts` owns UTF-8 framing, live output, and final partial-line flushing. `log-history.ts` owns retained snapshots and their limits. Import its constants and validation instead of duplicating numeric limits across CLI, protocol, and tests.
- Environment files are explicit, config-relative inputs loaded with the config. Do not mutate global `process.env`, expand values, or log file contents. Preserve case-insensitive Windows environment names through spawning.
- Dependencies and readiness gate starts and restarts. Changing them into ongoing health monitoring or cascading lifecycle behavior requires an explicit product decision and matching documentation.

When changing a shared feature, update its type, normalizer or protocol validator, CLI behavior, focused tests, and README examples together. Tests should follow the owning modules under `test/`; reuse `test/helpers/` for shared process fixtures rather than copying wire shapes or lifecycle setup.

## Package Notes

- `dist/` is generated and ignored by Git.
- The npm package publishes `dist`, `README.md`, `LICENSE`, and `package.json`.
- `prepack` rebuilds `dist` before packaging.
- Vite is an explicit development dependency so pnpm can update Vitest's required peer. Keep it within Vitest's supported range when refreshing test tooling.
- npm publishing is manual with `npm publish --access public`.
- Do not add npm tokens to the repo or GitHub Actions secrets for publishing.

## Before Changing Process Behavior

Run the full local check set:

```powershell
pnpm run lint
pnpm run build
pnpm test
pnpm run pack:check
```

For Windows process changes, add or update tests that cover tree killing, restart ordering, stale supervisor files, and final partial-line flushing.

For configuration and feature changes, cover environment precedence and Windows key aliases, dependency closure and selection conflicts, readiness timeout/abort cleanup, JSON error output, and bounded log snapshots where relevant. Include a real CLI or child-process check when unit tests alone cannot establish the user-visible behavior.
