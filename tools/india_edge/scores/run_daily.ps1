# Windows Task Scheduler entry point for the scores daily run.
# Usage (PowerShell):  .\run_daily.ps1            (normal)   |   .\run_daily.ps1 -Force   |   .\run_daily.ps1 -DryRun
# Secrets (optional Telegram failure alert) come from user environment variables, never from this repo:
#   [Environment]::SetEnvironmentVariable("TELEGRAM_BOT_TOKEN","<token>","User")
#   [Environment]::SetEnvironmentVariable("TELEGRAM_CHAT_ID","<chat id>","User")
param([switch]$Force, [switch]$DryRun, [switch]$NoFetch, [string]$AsOf = "", [string]$Fundamentals = "")
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path            # ...\tools\india_edge\scores
$edge = Split-Path -Parent $here                                    # ...\tools\india_edge
Set-Location $edge
$py = Join-Path $edge ".venv\Scripts\python.exe"
if (-not (Test-Path $py)) { $py = "python" }
$argsList = @("-m", "scores.daily")
if ($Force) { $argsList += "--force" }
if ($DryRun) { $argsList += "--dry-run" }
if ($NoFetch) { $argsList += "--no-fetch" }
if ($AsOf -ne "") { $argsList += @("--asof", $AsOf) }
if ($Fundamentals -ne "") { $argsList += @("--fundamentals", $Fundamentals) }
$logDir = Join-Path $here "out\logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
& $py @argsList *>> (Join-Path $logDir "scheduler_console.log")
$code = $LASTEXITCODE
# 0 = ok or already up to date, 1 = failed (alert sent if Telegram is configured), 3 = another run was active
exit $code
