# Starts the long-lived hidden desktop owner independently from the short app.start CLI process.
param(
  [Parameter(Mandatory = $true)][string]$OwnerScript,
  [Parameter(Mandatory = $true)][string]$RequestFile,
  [Parameter(Mandatory = $true)][string]$ResultFile,
  [Parameter(Mandatory = $true)][string]$ExitFile,
  [Parameter(Mandatory = $true)][string]$OwnerLog,
  [Parameter(Mandatory = $true)][string]$OwnerPidFile
)
$ErrorActionPreference = "Stop"
$errorLog = $OwnerLog + ".error"
function Quote-Argument([string]$value) { return '"' + $value.Replace('"', '\"') + '"' }
$arguments = @(
  "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $OwnerScript,
  "-RequestFile", $RequestFile, "-ResultFile", $ResultFile, "-ExitFile", $ExitFile
) | ForEach-Object { Quote-Argument ([string]$_) }
$owner = Start-Process -FilePath "powershell" -ArgumentList ($arguments -join " ") `
  -WindowStyle Hidden -RedirectStandardOutput $OwnerLog -RedirectStandardError $errorLog -PassThru
$owner.Id | Set-Content -LiteralPath $OwnerPidFile -Encoding ASCII
