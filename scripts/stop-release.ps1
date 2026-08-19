[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$scriptRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$projectRoot = if (Test-Path -LiteralPath (Join-Path $scriptRoot 'apps\api\dist')) { $scriptRoot } else { [IO.Path]::GetFullPath((Join-Path $scriptRoot '..')) }
$runtimeRoot = Join-Path $projectRoot '.runtime'
$statePath = Join-Path $runtimeRoot 'release-process.json'
$serverScriptPath = Join-Path $projectRoot 'apps\api\dist\server.js'

function Write-Status([string]$Message) {
  Write-Host "[knowledge-flashcards] $Message"
}

function Get-ManagedProcess([int]$ProcessId, [string]$Marker) {
  try {
    $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId"
  } catch {
    return $null
  }

  if ($null -eq $processInfo) {
    return $null
  }

  $commandLine = [string]$processInfo.CommandLine
  if ($commandLine.IndexOf($Marker, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
    return $null
  }

  return $processInfo
}

if (-not (Test-Path -LiteralPath $statePath)) {
  Write-Status 'No release process record was found. No other process was stopped.'
  exit 0
}

$state = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
$processId = [int]$state.appProcessId
$process = Get-ManagedProcess $processId $serverScriptPath
if ($null -eq $process) {
  Remove-Item -LiteralPath $statePath -Force
  Write-Status 'The release process is already gone. The process record was cleaned up.'
  exit 0
}

$taskkillPath = Join-Path $env:SystemRoot 'System32\taskkill.exe'
Write-Status "Stopping the production API and Web process tree (root PID $processId)."
& $taskkillPath /PID $processId /T /F | Out-Null
Start-Sleep -Milliseconds 500

if ($null -ne (Get-ManagedProcess $processId $serverScriptPath)) {
  throw "The release process $processId could not be stopped. Check permissions."
}

Remove-Item -LiteralPath $statePath -Force
Write-Status 'The production API and Web service stopped. MySQL was not stopped.'
