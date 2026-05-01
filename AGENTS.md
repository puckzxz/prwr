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

## Package Notes

- `dist/` is generated and ignored by Git.
- The npm package publishes `dist`, `README.md`, `LICENSE`, and `package.json`.
- `prepack` rebuilds `dist` before packaging.
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
