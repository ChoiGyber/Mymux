# MyCli

`MyCli` is a personal CLI for managing multiple shell sessions from one command.

## Features

- Open and track multiple named terminal sessions
- Re-attach to running sessions from later CLI invocations
- Persist session metadata under `~/.mycli/sessions.json`
- Keep recent terminal output and session log files under `~/.mycli/logs`
- Generate PowerShell completion

## Commands

```powershell
npm run build
npm link
mycli open work --cwd E:\Project
mycli list
mycli attach work
mycli logs work --lines 100
mycli restore
mycli kill work
mycli completion --shell powershell
```

Detach from an attached session with `Ctrl+P`.

## Notes

- The current MVP keeps sessions alive through the background daemon process.
- If the daemon stops, shell processes stop with it.
- Recent output is replayed when you re-attach to a session.
- PowerShell completion can be loaded by evaluating the output of `mycli completion --shell powershell`.
- On Windows, `pwsh` is preferred when available, then Windows PowerShell, then `cmd.exe`.
