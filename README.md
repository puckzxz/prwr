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
prwr restart backend
prwr stop docs
prwr start docs
prwr down
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

Runtime state is stored in `.prwr/supervisor.json` inside the project. That file is how `status`, `restart`, `stop`, `start`, and `down` find the running supervisor.

## Process Options

```yaml
processes:
  backend:
    command: npm run dev
    cwd: ./apps/backend
    env:
      PORT: "3001"
    restart: manual
    killOnExit: false
    startupDelayMs: 0
```

- `command`: command to run. Required.
- `cwd`: working directory, resolved relative to the config file.
- `env`: environment values merged with the parent process.
- `restart`: `manual`, `always`, or `on-failure`. Defaults to `manual`.
- `killOnExit`: when true, this process exiting stops the whole supervisor.
- `startupDelayMs`: delay before starting the process.

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
| `prwr up` | Same as `prwr`. |
| `prwr status` | Show supervisor and process state. |
| `prwr restart <name>` | Kill one process tree and start it again. |
| `prwr stop <name>` | Stop one process. |
| `prwr start <name>` | Start one stopped process. |
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

Use `--no-color` or `NO_COLOR=1` to turn label colors off:

```powershell
prwr --no-color
```

## Local Development

```powershell
pnpm install
pnpm run build
pnpm test
node dist/cli.js --help
```

## Release Process

Releases are published as `@puckzxz/prwr` on npm.

For the next release:

1. Update the version in `package.json`.
2. Run `pnpm run lint`, `pnpm run build`, `pnpm test`, and `pnpm run pack:check`.
3. Commit the version change.
4. Tag the commit with the same version, for example `git tag -a v0.1.1 -m "v0.1.1"`.
5. Push the commit and tag.

The `Publish` GitHub Actions workflow runs on `v*.*.*` tags and publishes with npm trusted publishing. Before the first automated publish, configure npm's trusted publisher for this package to use:

- GitHub owner: `puckzxz`
- Repository: `prwr`
- Workflow: `publish.yml`

## Limitations

- Child stdin is ignored, so interactive child processes are not supported.
- Child color output depends on the child tool.
- Windows stops use `taskkill /F`, so shutdown is forceful by design.
