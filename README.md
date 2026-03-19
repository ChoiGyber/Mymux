# MyCli

`MyCli` is a personal CLI for managing multiple shell sessions from one command.

## Features

- Open and track multiple named terminal sessions
- Re-attach to running sessions from later CLI invocations
- Persist session metadata under `~/.mycli/sessions.json`
- Keep recent terminal output and session log files under `~/.mycli/logs`
- Support per-project profiles from `mycli.config.json`
- Generate PowerShell completion

## Commands

```powershell
npm run build
npm link
mycli init
mycli profile add backend --cwd E:\Project\MyCli --shell "C:\Program Files\PowerShell\7\pwsh.exe" --env NODE_ENV=development
mycli profile rename backend backend-dev
mycli open work --cwd E:\Project
mycli open api --profile backend
mycli open web --env NODE_ENV=development --env PORT=3000
mycli list --status running --match api
mycli inspect api --logs 20
mycli profile show backend
mycli config export
mycli config import .\shared-mycli.json
mycli rename api api-dev
mycli session export
mycli attach work
mycli logs work --lines 100 --clean --since 10m --follow
mycli restore
mycli daemon status
mycli daemon doctor
mycli daemon restart
mycli kill work
mycli completion --shell powershell
```

Detach from an attached session with `Ctrl+P`.

## Notes

- The current MVP keeps sessions alive through the background daemon process.
- If the daemon stops, shell processes stop with it.
- Recent output is replayed when you re-attach to a session.
- Non-interactive `attach` runs detach automatically when piped stdin closes.
- `mycli daemon restart` starts a fresh daemon and rehydrates saved sessions.
- `mycli daemon doctor` checks daemon, state, logs, and project config paths.
- `mycli config import` merges profiles by default and supports `--replace`.
- `mycli logs --follow` tails the underlying session log file.
- `mycli logs --since` accepts ISO timestamps or relative values like `10m`, `2h`, `1d`.
- PowerShell completion can be loaded by evaluating the output of `mycli completion --shell powershell`.
- On Windows, `pwsh` is preferred when available, then Windows PowerShell, then `cmd.exe`.

## Project Config

Create `mycli.config.json` in your project root:

```json
{
  "profiles": {
    "backend": {
      "cwd": "E:\\Project\\MyCli",
      "shell": "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
      "env": {
        "NODE_ENV": "development",
        "API_PORT": "4000"
      }
    }
  }
}
```
