<#
  reward-guard.ps1 - Reward Vault enforcement agent for CHEFFYPC.

  Polls the Reward Vault API. While NO reward timer is active, it kills any process
  running from a configured game folder (blockPaths) or matching a launcher name
  (blockProcessNames), unless it is spared by allowPaths / allowProcessNames. Any active
  timer (handheld / grinder / raid) unlocks everything.

  Before a running timer expires it pops a warning (default 10 and 5 minutes left)
  that lets you spend a vaulted reward to add more time, or open the dashboard to buy.

  Two modes:
    (default)   run the guard loop
    -WarnMode   show the expiry warning dialog (the loop spawns this for itself)

  Runs under Windows PowerShell 5.1 (powershell.exe). Install via install-reward-guard.ps1.
  Keep this file ASCII-only: Windows PowerShell 5.1 reads .ps1 as ANSI, and stray Unicode
  (e.g. an em dash) decodes into characters it treats as string delimiters and won't parse.
#>
[CmdletBinding()]
param(
  [switch]$WarnMode,
  [int]$RemainingMinutes = 0,
  [string]$ApiBase = "",
  [string]$ConfigPath = ""
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# ----- config -----
if (-not $ConfigPath) { $ConfigPath = Join-Path $PSScriptRoot "reward-guard.config.json" }
$cfg = Get-Content -Raw -Path $ConfigPath | ConvertFrom-Json

if ($cfg.skipCertCheck) {
  # Windows PowerShell 5.1 has no -SkipCertificateCheck; install a permissive callback.
  [Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
}

$LogDir  = Join-Path $env:ProgramData "RewardGuard"
$LogFile = Join-Path $LogDir "reward-guard.log"
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Force -Path $LogDir | Out-Null }

function Write-Log([string]$msg) {
  $line = "{0}  {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg
  try { Add-Content -Path $LogFile -Value $line } catch {}
}

# Never touch these, no matter what.
$Protected = @("system","idle","registry","memory compression","csrss","wininit","winlogon",
  "services","lsass","smss","dwm","explorer","powershell","pwsh","conhost","taskhostw",
  "ctfmon","fontdrvhost","sihost","searchhost","startmenuexperiencehost","reward-guard")

# ----- API helpers -----
function Resolve-ApiBase {
  foreach ($u in $cfg.apiUrls) {
    try {
      $r = Invoke-RestMethod -Method Get -Uri ("{0}/api/state" -f $u.TrimEnd('/')) -TimeoutSec 6
      if ($r.serverTime) { return $u.TrimEnd('/') }
    } catch { }
  }
  return $null
}

function Get-State([string]$base) {
  try { return Invoke-RestMethod -Method Get -Uri ("{0}/api/state" -f $base) -TimeoutSec 6 }
  catch { return $null }
}

function Invoke-Extend([string]$base, [string]$rewardId) {
  return Invoke-RestMethod -Method Post -Uri ("{0}/api/extend" -f $base) `
    -Body (@{ rewardId = $rewardId } | ConvertTo-Json -Compress) -ContentType "application/json" -TimeoutSec 8
}

function Invoke-Heartbeat([string]$base, [bool]$locked) {
  # Best-effort: tell the server our lock state so the dashboard can show this PC.
  try {
    Invoke-RestMethod -Method Post -Uri ("{0}/api/guard/heartbeat" -f $base) `
      -Body (@{ host = $env:COMPUTERNAME; locked = $locked; version = "1" } | ConvertTo-Json -Compress) `
      -ContentType "application/json" -TimeoutSec 6 | Out-Null
  } catch { }
}

function Now-Ms { [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }

# =====================================================================
# WARN MODE - interactive expiry dialog (spawned by the guard loop)
# =====================================================================
if ($WarnMode) {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  if (-not $ApiBase) { $ApiBase = Resolve-ApiBase }
  $state = if ($ApiBase) { Get-State $ApiBase } else { $null }

  $form = New-Object System.Windows.Forms.Form
  $form.Text = "Reward Vault"
  $form.Size = New-Object System.Drawing.Size(420, 250)
  $form.StartPosition = "CenterScreen"
  $form.TopMost = $true
  $form.FormBorderStyle = "FixedDialog"
  $form.MaximizeBox = $false; $form.MinimizeBox = $false

  $lbl = New-Object System.Windows.Forms.Label
  $lbl.Text = "~$RemainingMinutes minutes of game time left.`r`nAdd more time, or it locks when the timer ends."
  $lbl.Location = New-Object System.Drawing.Point(16, 14)
  $lbl.Size = New-Object System.Drawing.Size(380, 44)
  $form.Controls.Add($lbl)

  $y = 66
  if ($state -and $state.rewards) {
    foreach ($r in $state.rewards) {
      $stock = [int]$state.stacks.($r.id)
      $mins = if ($r.editable) { [int]$state.raidDuration } else { [int]$r.defaultMins }
      $btn = New-Object System.Windows.Forms.Button
      $btn.Text = "+$mins min  $($r.name)   ($stock in vault)"
      $btn.Location = New-Object System.Drawing.Point(16, $y)
      $btn.Size = New-Object System.Drawing.Size(380, 30)
      $btn.Enabled = ($stock -gt 0)
      $rid = $r.id
      $btn.Add_Click({
        try {
          $resp = Invoke-Extend $ApiBase $rid
          $lbl.Text = "Added time. New total: $($resp.activeTimer.duration) min."
          $form.Controls | Where-Object { $_ -is [System.Windows.Forms.Button] } | ForEach-Object { $_.Enabled = $false }
          $closeTimer = New-Object System.Windows.Forms.Timer
          $closeTimer.Interval = 1500; $closeTimer.Add_Tick({ $closeTimer.Stop(); $form.Close() }); $closeTimer.Start()
        } catch {
          $lbl.Text = "Could not add time: $($_.Exception.Message)"
        }
      }.GetNewClosure())
      $form.Controls.Add($btn)
      $y += 34
    }
  } else {
    $lbl.Text = "Game time is almost up, but the vault is unreachable right now."
  }

  $form.Size = New-Object System.Drawing.Size(420, ($y + 90))

  $open = New-Object System.Windows.Forms.Button
  $open.Text = "Open dashboard"
  $open.Location = New-Object System.Drawing.Point(16, ($y + 6))
  $open.Size = New-Object System.Drawing.Size(180, 30)
  $open.Add_Click({ if ($ApiBase) { Start-Process $ApiBase } }.GetNewClosure())
  $form.Controls.Add($open)

  $dismiss = New-Object System.Windows.Forms.Button
  $dismiss.Text = "Dismiss"
  $dismiss.Location = New-Object System.Drawing.Point(216, ($y + 6))
  $dismiss.Size = New-Object System.Drawing.Size(180, 30)
  $dismiss.Add_Click({ $form.Close() })
  $form.Controls.Add($dismiss)

  # Auto-close so an ignored warning does not linger forever.
  $auto = New-Object System.Windows.Forms.Timer
  $auto.Interval = [Math]::Max(10, [int]$cfg.warnTimeoutSeconds) * 1000
  $auto.Add_Tick({ $auto.Stop(); $form.Close() })
  $auto.Start()

  [void]$form.ShowDialog()
  return
}

# =====================================================================
# GUARD LOOP
# =====================================================================
Write-Log "guard starting (poll $($cfg.pollSeconds)s)"
$blockPaths = @($cfg.blockPaths | ForEach-Object { $_.ToLower().TrimEnd('\') })
$blockNames = @($cfg.blockProcessNames | ForEach-Object { $_.ToLower() })
$allowNames = @($cfg.allowProcessNames | ForEach-Object { $_.ToLower() })
# Folders to spare even when they sit under a blocked path (e.g. Wallpaper Engine, which
# lives inside the Steam common folder). Safe if the key is absent in an older config.
$allowPaths = @()
if ($cfg.allowPaths) { $allowPaths = @($cfg.allowPaths | ForEach-Object { $_.ToLower().TrimEnd('\') }) }

$apiBase = $null
$lastTimerId = $null
$firedWarns = @{}            # threshold -> $true, reset per timer
$wasLocked = $null
$self = $PSCommandPath       # full path to this script, for relaunching warn dialogs
$warnThresholds = @($cfg.warnMinutes | Sort-Object -Descending)

function Test-ShouldKill($proc) {
  $name = $proc.ProcessName.ToLower()
  if ($Protected -contains $name) { return $false }
  if ($allowNames -contains $name) { return $false }
  $path = $null
  try { $path = $proc.Path } catch { return $false }   # protected/system proc - skip
  if (-not $path) { return $false }
  $lp = $path.ToLower()
  if ($lp.StartsWith("c:\windows\")) { return $false }
  foreach ($ap in $allowPaths) { if ($lp.StartsWith($ap + '\')) { return $false } }  # spared folders win
  if ($blockNames -contains $name) { return $true }
  foreach ($bp in $blockPaths) { if ($lp.StartsWith($bp + '\')) { return $true } }
  return $false
}

function Invoke-Enforce {
  $killed = @()
  foreach ($p in Get-Process) {
    try {
      if (Test-ShouldKill $p) {
        Stop-Process -Id $p.Id -Force -ErrorAction Stop
        $killed += $p.ProcessName
      }
    } catch { }
  }
  if ($killed.Count -gt 0) { Write-Log ("killed: " + (($killed | Group-Object | ForEach-Object { "$($_.Name)x$($_.Count)" }) -join ", ")) }
}

while ($true) {
  try {
    if (-not $apiBase) { $apiBase = Resolve-ApiBase }
    $state = if ($apiBase) { Get-State $apiBase } else { $null }
    if (-not $state) { $apiBase = $null }   # force re-resolve next loop

    $timer = if ($state) { $state.activeTimer } else { $null }
    $locked = $false

    if ($state) {
      $locked = ($null -eq $timer)
    } else {
      $locked = [bool]$cfg.blockWhenUnreachable    # fail-open by default
    }

    if ($apiBase) { Invoke-Heartbeat $apiBase $locked }

    # Warnings while a timer is running
    if ($timer) {
      if ($timer.id -ne $lastTimerId) { $lastTimerId = $timer.id; $firedWarns = @{} }
      $remainMin = [Math]::Floor((($timer.endsAt - (Now-Ms)) / 60000.0))
      for ($i = 0; $i -lt $warnThresholds.Count; $i++) {
        $th = $warnThresholds[$i]
        # Lower bound of this threshold's band = next-smaller threshold (or -1). Firing only
        # inside the band stops a mid-timer startup from popping every threshold at once.
        $lower = if ($i -lt $warnThresholds.Count - 1) { $warnThresholds[$i + 1] } else { -1 }
        if ($remainMin -le $th -and $remainMin -gt $lower -and -not $firedWarns.ContainsKey($th)) {
          $firedWarns[$th] = $true
          Write-Log "warning: ~$remainMin min left (threshold $th)"
          Start-Process -FilePath "powershell.exe" -WindowStyle Hidden -ArgumentList @(
            "-ExecutionPolicy","Bypass","-File","`"$self`"","-WarnMode",
            "-RemainingMinutes",$remainMin,"-ApiBase","`"$apiBase`"","-ConfigPath","`"$ConfigPath`""
          ) | Out-Null
        }
      }
    } else {
      $lastTimerId = $null; $firedWarns = @{}
    }

    if ($locked) { Invoke-Enforce }

    if ($locked -ne $wasLocked) { Write-Log ("state: " + $(if ($locked) { "LOCKED (blocking games)" } else { "unlocked" })); $wasLocked = $locked }
  } catch {
    Write-Log "loop error: $($_.Exception.Message)"
  }
  Start-Sleep -Seconds ([Math]::Max(2, [int]$cfg.pollSeconds))
}
