export function renderPowerShellCompletion(): string {
  return `
Register-ArgumentCompleter -Native -CommandName mycli -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)

  $commands = @('init', 'open', 'list', 'inspect', 'attach', 'kill', 'rename', 'restore', 'logs', 'daemon', 'profiles', 'profile', 'config', 'session', 'completion')
  $commandElements = $commandAst.CommandElements | ForEach-Object { $_.Extent.Text }

  if ($commandElements.Count -le 2) {
    $commands |
      Where-Object { $_ -like "$wordToComplete*" } |
      ForEach-Object {
        [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
      }
    return
  }

  $subcommand = $commandElements[1]
  if ($subcommand -in @('attach', 'inspect', 'kill', 'rename', 'logs')) {
    try {
      $sessions = mycli list --json | ConvertFrom-Json
      $sessions |
        ForEach-Object { $_.name } |
        Where-Object { $_ -like "$wordToComplete*" } |
        ForEach-Object {
          [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
        }
    } catch {
    }
  }

  if ($subcommand -eq 'open') {
    try {
      $profiles = mycli profiles --json | ConvertFrom-Json
      if ($commandElements -contains '--profile') {
        $profiles |
          Where-Object { $_ -like "$wordToComplete*" } |
          ForEach-Object {
            [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
          }
      }
    } catch {
    }
  }

  if ($subcommand -eq 'profile') {
    $profileCommands = @('add', 'remove', 'show', 'rename', 'validate', 'template')
    if ($commandElements.Count -le 3) {
      $profileCommands |
        Where-Object { $_ -like "$wordToComplete*" } |
        ForEach-Object {
          [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
        }
    }
  }

  if ($subcommand -eq 'daemon') {
    $daemonCommands = @('status', 'stop', 'restart', 'doctor', 'autostart')
    if ($commandElements.Count -le 3) {
      $daemonCommands |
        Where-Object { $_ -like "$wordToComplete*" } |
        ForEach-Object {
          [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
        }
    }
  }

  if ($subcommand -eq 'config') {
    $configCommands = @('export', 'import', 'diff', 'backup', 'restore')
    if ($commandElements.Count -le 3) {
      $configCommands |
        Where-Object { $_ -like "$wordToComplete*" } |
        ForEach-Object {
          [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
        }
    }
  }

  if ($subcommand -eq 'session') {
    $sessionCommands = @('export', 'import')
    if ($commandElements.Count -le 3) {
      $sessionCommands |
        Where-Object { $_ -like "$wordToComplete*" } |
        ForEach-Object {
          [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
        }
    }
  }

  if ($subcommand -eq 'daemon' -and $commandElements[2] -eq 'autostart') {
    $autostartCommands = @('enable', 'disable', 'status')
    if ($commandElements.Count -le 4) {
      $autostartCommands |
        Where-Object { $_ -like "$wordToComplete*" } |
        ForEach-Object {
          [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
        }
    }
  }
}
`.trim();
}
