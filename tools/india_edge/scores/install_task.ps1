# One-time: register the daily task (21:00 local time, Mon-Fri; set the PC clock to IST).
# NSE usually publishes bhavcopy by ~19:00 IST. Run in an elevated PowerShell:  .\install_task.ps1
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$script = Join-Path $here "run_daily.ps1"
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$script`""
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday -At 21:00
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 2) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName "NiftyRadar Scores Daily" -Action $action -Trigger $trigger -Settings $settings -Description "Download bhavcopy, run scores/screeners/rotation/fear-greed, write JSON + static site" -Force
