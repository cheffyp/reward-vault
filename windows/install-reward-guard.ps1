<#
  install-reward-guard.ps1 - set up the Reward Vault guard on CHEFFYPC.

  Run this once, as Administrator (right-click > Run with PowerShell, or it will self-elevate).
  It copies the agent to C:\ProgramData\RewardGuard and registers a scheduled task that:
    - starts at logon, runs in your session (so warnings can pop up),
    - runs with highest privileges (so it can stop elevated games),
    - re-launches itself every 2 minutes if it was closed (auto-restart),
    - runs hidden, with no time limit, single-instance.

  Re-run after editing reward-guard.config.json to refresh the installed copy.
#>
[CmdletBinding()]
param(
  [string]$TaskName = "RewardGuard"
)

# --- self-elevate ---
$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin = (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
if (-not $isAdmin) {
  Write-Host "Elevating to Administrator..."
  Start-Process -FilePath "powershell.exe" -Verb RunAs -ArgumentList @(
    "-ExecutionPolicy","Bypass","-File","`"$PSCommandPath`"","-TaskName","`"$TaskName`""
  )
  return
}

$srcDir  = $PSScriptRoot
$destDir = Join-Path $env:ProgramData "RewardGuard"
New-Item -ItemType Directory -Force -Path $destDir | Out-Null

# Stop any running instance so the agent script can be refreshed and reloaded cleanly.
Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | Out-Null

Copy-Item (Join-Path $srcDir "reward-guard.ps1") (Join-Path $destDir "reward-guard.ps1") -Force
$destCfg = Join-Path $destDir "reward-guard.config.json"
if (Test-Path $destCfg) {
  Write-Host "Config already present at $destCfg - leaving it (edit it there, or delete to reset)."
} else {
  Copy-Item (Join-Path $srcDir "reward-guard.config.json") $destCfg -Force
}

$script = Join-Path $destDir "reward-guard.ps1"
$cfgArg = Join-Path $destDir "reward-guard.config.json"

$action = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument ("-ExecutionPolicy Bypass -WindowStyle Hidden -File `"{0}`" -ConfigPath `"{1}`"" -f $script, $cfgArg)

# At logon, plus repeat every 2 min forever (relaunch if killed; single-instance ignores dupes).
$trigger = New-ScheduledTaskTrigger -AtLogOn
$repeat = (New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 2)).Repetition
$trigger.Repetition = $repeat

$principal = New-ScheduledTaskPrincipal -UserId ("{0}\{1}" -f $env:USERDOMAIN, $env:USERNAME) `
  -LogonType Interactive -RunLevel Highest

$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries -StartWhenAvailable -Hidden -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings -Force | Out-Null

Start-ScheduledTask -TaskName $TaskName

$logPath = Join-Path $destDir "reward-guard.log"
Write-Host ""
Write-Host "Installed and started '$TaskName'."
Write-Host "  Agent:  $script"
Write-Host "  Config: $cfgArg"
Write-Host "  Log:    $logPath"
Write-Host ""
Write-Host "Check it:   Get-ScheduledTask $TaskName"
Write-Host "Watch log:  Get-Content '$logPath' -Tail 20 -Wait"
Write-Host ("Uninstall:  Unregister-ScheduledTask " + $TaskName + " -Confirm:" + '$false')
