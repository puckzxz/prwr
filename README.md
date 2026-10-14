# prwr

Process Wrangler, or `prwr`, is a small process supervisor for local development.

It runs the commands your project needs, keeps their output in one terminal, and gives each line a stable colored label. It is built for Windows first, with no tmux, panes, curses, or TUI.

```text
backend | started pid=12644
web     | started pid=18408
backend | Ready on http://localhost:8787
web     | VITE v7 ready in 420 ms
```

## Install

```powershell
npm install -g @puckzxz/prwr
```

Then add a `.prwr.yml` file to a project and run `prwr` from that project directory.

## Quick Start

```yaml
processes:
  backend:
    command: npm run dev:backend
    restart: on-failure

  web:
    command: npm run dev:web
    stdin: true
    env:
      PORT: "3000"

  docs:
    command: npm run dev
    cwd: ./docs
```

Start everything:

```powershell
prwr
```

From another terminal in the same folder:

```powershell
prwr status
prwr status --json
prwr logs backend --tail 100
prwr restart backend
prwr send web rs
prwr stop docs
prwr start docs
prwr down
prwr check
```

## Config Files

`prwr` looks for config in this order:

1. `.prwr.yml`
2. `.prwr.yaml`
3. `Procfile.dev`
4. `Procfile`

You can also pass a config path directly:

```powershell
prwr .\.prwr.yml
prwr .\Procfile.dev
prwr up --config .\.prwr.yml
prwr up --procfile .\Procfile.dev
```

Runtime state is stored in `.prwr/supervisor.json` inside the config file's directory. Run control commands from that directory so they can find the supervisor.

Control commands verify the supervisor's identity before using that state. Identity checks and most commands wait up to five seconds for a response; `start` and `restart` wait up to 60 seconds. A longer operation can continue after the client reports a timeout. Supervisor state is preserved when a live supervisor cannot be reached, so check `prwr status` before retrying a start or restart.

## Process Options

```yaml
processes:
  backend:
    command: npm run dev
    cwd: ./apps/backend
    env:
      PORT: "3001"
    envFile: ./backend.env
    dependsOn: []
    readyWhen:
      type: http
      url: http://127.0.0.1:3001/health
    restart: manual
    killOnExit: false
    stdin: false
    startupDelayMs: 0
    restartBackoffMs: 0
    restartBackoffMaxMs: 0
    restartBackoffResetMs: 0
    restartMaxAttempts: 0
```

- `command`: command to run. Required.
- `cwd`: working directory, resolved relative to the config file.
- `env`: environment values merged with the parent process.
- `envFile`: a path or ordered list of paths to environment files. See [Environment Files](#environment-files).
- `dependsOn`: a process name or list of process names that must be running before this process starts.
- `readyWhen`: a TCP or HTTP readiness check that must pass before the process is marked running. Omit it to use successful spawning as the startup gate.
- `restart`: `manual`, `always`, or `on-failure`. Defaults to `manual`.
- `killOnExit`: when true, this process exiting stops the whole supervisor.
- `stdin`: when true, enables `prwr send <name> <text>` for this process.
- `startupDelayMs`: delay before starting the process.
- `restartBackoffMs`: first automatic restart delay. Defaults to the existing `Math.max(100, startupDelayMs)` behavior when unset.
- `restartBackoffMaxMs`: maximum automatic restart delay. Defaults to no extra backoff cap when unset.
- `restartBackoffResetMs`: stable run time before automatic restart attempts reset. Defaults to disabled.
- `restartMaxAttempts`: maximum consecutive automatic restart attempts. `0` means unlimited.

## Environment Files

Environment files are opt-in through YAML `envFile`; `prwr` does not automatically discover `.env`. Both the top-level setting and each process's setting accept one path or a nonempty list of paths. Every path resolves relative to the config file's directory, including when a process uses a different `cwd`.

For example, create these files beside `.prwr.yml`:

```dotenv
# .env
PORT=3000
LOG_LEVEL=info
```

```dotenv
# .env.local
LOG_LEVEL=debug
```

```dotenv
# backend.env
PORT=3001
```

```yaml
envFile: [.env, .env.local]
processes:
  backend:
    command: node -e "console.log(process.env.PORT); setInterval(() => {}, 1000)"
    envFile: backend.env
    env:
      PORT: "4000"
```

Values apply in this order, with each later layer taking precedence:

1. Shared files, in their listed order.
2. Per-process files, in their listed order.
3. Environment inherited from the shell that started `prwr`.
4. Inline process `env` values in YAML.

The example prints `4000`. Removing inline `PORT` uses a shell-provided `PORT` if present, otherwise `3001` from `backend.env`. On Windows, names such as `PATH` and `Path` refer to the same variable and are merged into a single child environment key.

Files support dotenv quoting, comments, empty values, and multiline values. Variable references such as `${PORT}` are left literal; `prwr` performs no variable expansion or command substitution. It does not modify its own global environment or print file contents while loading. Missing configured files are errors.

Files are read when `up` loads the config, and also when `check` validates it. A running supervisor retains those values for subsequent starts and restarts. After editing a file, use `prwr down` followed by `prwr up` to reload it.

## Selecting Processes

Use `--only` and `--exclude` with `up` or `check` to select the processes for that run:

```powershell
prwr up --only backend,web
prwr up --only backend --only web --exclude docs
prwr check --only web
```

Both flags accept comma-separated names and repeated flags. `--only` includes the selected processes' full dependency chain automatically. With no `--only`, all configured processes are selected before applying exclusions. The chosen set stays fixed for that supervisor; `start` cannot add a process omitted from its configuration.

Unknown names, empty selections, and selecting and excluding the same explicit name are errors. Excluding a dependency required by a selected process is also an error. The entire configured dependency graph is validated for unknown dependencies and cycles, even when a process is unselected.

## Readiness And Dependencies

Use `readyWhen` and `dependsOn` to wait for services before starting their dependents. This example uses only Node commands:

```yaml
processes:
  database:
    command: node -e "require('node:net').createServer(s => s.end()).listen(5432, '127.0.0.1')"
    readyWhen:
      type: tcp
      port: 5432

  backend:
    command: node -e "require('node:http').createServer((req, res) => res.end('ok')).listen(3001, '127.0.0.1')"
    dependsOn: database
    readyWhen:
      type: http
      url: http://127.0.0.1:3001/health
      timeoutMs: 15000
      intervalMs: 200

  web:
    command: node -e "console.log('dependencies ready'); setInterval(() => {}, 1000)"
    dependsOn: [backend]
```

Run it with `prwr up --only web`: the database starts first, then the backend, then the web process. `prwr` waits for each configured readiness check before proceeding.

TCP checks succeed when a connection opens; `host` defaults to `127.0.0.1`. HTTP checks require an absolute HTTP or HTTPS URL without embedded credentials and succeed on a 2xx response. Redirects are not followed. Both checks default to `timeoutMs: 10000` and `intervalMs: 100`; these settings must be positive integer milliseconds.

While waiting, status reports `starting`. Readiness is checked on every initial start, manual start, and restart, including automatic restarts. Without `readyWhen`, a successful command spawn marks the process `running`. Dependencies must be running when a process starts or restarts; a manual `start` does not start stopped dependencies for you.

A readiness timeout stops the newly started process tree and records a startup failure. Its configured restart policy and `killOnExit` behavior still apply. `startupDelayMs` remains an optional delay before spawning and is separate from readiness polling.

These are startup gates. They do not monitor health after startup or cascade stops and restarts to already running dependents. `prwr check` validates configuration, dependency structure, selected working directories, and supervisor state; it does not run commands or probe readiness endpoints.

## Machine-Readable Status

Use JSON status from scripts or other tools:

```powershell
$status = prwr status --json | ConvertFrom-Json
$status.processes | Select-Object name, state, pid
```

Success prints one JSON object with `supervisor` and `processes` and exits with code `0`. Process records include names, states, PIDs, command text, working directories, restart counts, and the last exit or error. The supervisor authentication token and process environment mappings are excluded.

Failures, including invalid arguments or an unavailable supervisor, print one JSON object and exit with code `1`:

```json
{"ok":false,"error":"prwr supervisor is not running for this project."}
```

## Recent Logs

Read recent output from another terminal:

```powershell
prwr logs backend
prwr logs backend --tail 100 --no-color
prwr logs backend --tail 1000
```

This returns a snapshot and exits. The default is 50 entries; `--tail` without a number also uses 50. A count between `0` and `1000` is accepted. Entries include completed stdout and stderr lines plus lifecycle events, in the order the supervisor recorded them for that process. They display their original UTC timestamps and are written to their original stdout or stderr stream.

History is held in memory for the running supervisor, including across individual process restarts. Each process retains at most 1,000 entries and 128 KiB of serialized entries, whichever limit is reached first. Retained entry text is capped at 8 KiB with a truncation marker that preserves UTF-8 boundaries. Live output remains unchanged.

Final partial lines are recorded when output streams close. Logs are not persisted after the supervisor exits, and there is no continuous follow mode.

## Procfile Support

Simple Foreman-style Procfiles work too:

```text
backend: npm run dev:backend
web: npm run dev:web
docs: npm run dev
```

Procfile commands run from the Procfile directory and use manual restart behavior.

## Command Reference

| Command | What it does |
| --- | --- |
| `prwr` | Start the project using the first matching config file. |
| `prwr up [--only <names>] [--exclude <names>]` | Start the project, optionally selecting processes and their required dependencies. |
| `prwr check [--only <names>] [--exclude <names>]` | Validate config, selected working directories, and supervisor state without starting processes. |
| `prwr status [--json]` | Show supervisor and process state, optionally as JSON. |
| `prwr logs <name> [--tail [N]]` | Print a snapshot of recent output and lifecycle events. |
| `prwr restart <name>` | Kill one process tree and start it again. |
| `prwr stop <name>` | Stop one process. |
| `prwr start <name>` | Start one stopped process. |
| `prwr send <name> <text>` | Send one newline-terminated input command to a process with `stdin: true`. |
| `prwr down` | Stop every process tree and exit the supervisor. |

## Windows Behavior

Windows is the main target. When `prwr` stops a process, it kills the whole tree:

```powershell
taskkill /PID <pid> /T /F
```

That matters for commands like `npm run dev`, where the process you see first is often not the server doing the real work. `prwr down`, Ctrl+C, and `prwr restart <name>` all use the same tree-kill path.

On macOS and Linux, `prwr` starts processes in their own process groups where possible and stops the group with POSIX signals.

## Output And Color

`prwr` colors the label and separator by default. Child output is passed through unchanged.

UTF-8 characters are preserved across output chunks. Final partial lines on stdout and stderr are flushed after the child's output streams close, before an automatic restart begins.

Use `--no-color` or `NO_COLOR=1` to turn label colors off:

```powershell
prwr --no-color
```

`--no-color` only controls `prwr` labels. Child commands still decide their own color output, and `prwr` preserves the existing default of setting `FORCE_COLOR=1` unless it is already set.

Use `--timestamps` to prefix each log line with local time:

```powershell
prwr --timestamps
prwr up --timestamps
```

```text
14:32:07 backend | Ready on http://localhost:8787
```

## Local Development

```powershell
pnpm install
pnpm run lint
pnpm run build
pnpm test
pnpm run pack:check
node dist/cli.js --help
```

## Release Process

Releases are published as `@puckzxz/prwr` on npm.

For the next release:

1. Update the version in `package.json`.
2. Run `pnpm run lint`, `pnpm run build`, `pnpm test`, and `pnpm run pack:check`.
3. Commit the version change.
4. Push the commit and wait for CI to pass.
5. Publish from a local terminal with `npm publish --access public`.
6. Tag the commit with the same version, for example `git tag -a v0.1.1 -m "v0.1.1"`.
7. Push the tag and create a GitHub release.

CI runs on pushes and tags. npm publishing is intentionally manual for now.

## Limitations

- Child stdin is ignored unless `stdin: true` is set. `prwr send` is one-shot command input, not an interactive terminal.
- Child color output depends on the child tool.
- Windows stops use `taskkill /F`, so shutdown is forceful by design.
