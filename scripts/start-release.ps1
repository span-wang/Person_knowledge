[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$scriptRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$projectRoot = if (Test-Path -LiteralPath (Join-Path $scriptRoot 'apps\api\dist')) { $scriptRoot } else { [IO.Path]::GetFullPath((Join-Path $scriptRoot '..')) }
$runtimeRoot = Join-Path $projectRoot '.runtime'
$statePath = Join-Path $runtimeRoot 'release-process.json'
$logRoot = Join-Path $runtimeRoot 'logs'
$nodePath = Join-Path $projectRoot 'runtime\node\node.exe'
$serverScriptPath = Join-Path $projectRoot 'apps\api\dist\server.js'
$databaseCheckPath = Join-Path $projectRoot 'apps\api\dist\database-check.js'
$storageCheckPath = Join-Path $projectRoot 'apps\api\dist\storage-check.js'
$webDistPath = Join-Path $projectRoot 'apps\web\dist'

function Get-ConfiguredValue([string]$Name, [string]$Fallback) {
  $environmentValue = [Environment]::GetEnvironmentVariable($Name)
  if (-not [string]::IsNullOrWhiteSpace($environmentValue)) {
    return $environmentValue.Trim()
  }

  $pattern = '^\s*' + [regex]::Escape($Name) + '\s*=\s*(.*)\s*$'
  foreach ($fileName in @('.env', '.env.local')) {
    $filePath = Join-Path $projectRoot $fileName
    if (-not (Test-Path -LiteralPath $filePath)) {
      continue
    }

    foreach ($line in Get-Content -LiteralPath $filePath) {
      $match = [regex]::Match($line, $pattern)
      if ($match.Success) {
        $value = $match.Groups[1].Value.Trim()
        if ($value.Length -ge 2 -and (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'")))) {
          $value = $value.Substring(1, $value.Length - 2)
        }
        return $value
      }
    }
  }

  return $Fallback
}

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

function Stop-ProcessTree([int]$ProcessId, [string]$Marker) {
  if ($null -eq (Get-ManagedProcess $ProcessId $Marker)) {
    return
  }

  $taskkillPath = Join-Path $env:SystemRoot 'System32\taskkill.exe'
  & $taskkillPath /PID $ProcessId /T /F | Out-Null
}

function Test-HttpEndpoint([string]$Uri) {
  try {
    $response = Invoke-WebRequest -Uri $Uri -TimeoutSec 2 -UseBasicParsing
    return $response.StatusCode -eq 200
  } catch {
    return $false
  }
}

function Assert-PortAvailable([int]$Port) {
  $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
  if ($listeners.Count -eq 0) {
    return
  }

  $processIds = $listeners | Select-Object -ExpandProperty OwningProcess -Unique
  throw "Port $Port is already used by another process (PIDs: $($processIds -join ', ')). The release script will not stop it."
}

function Invoke-NodeScript([string]$ScriptPath) {
  & $nodePath $ScriptPath
  if ($LASTEXITCODE -ne 0) {
    throw "Check failed: $([IO.Path]::GetFileName($ScriptPath))"
  }
}

if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) {
  throw "The fixed Node.js runtime is missing: $nodePath"
}
if (-not (Test-Path -LiteralPath $serverScriptPath -PathType Leaf)) {
  throw "The API build output is missing: $serverScriptPath"
}
if (-not (Test-Path -LiteralPath (Join-Path $webDistPath 'index.html') -PathType Leaf)) {
  throw "The Web build output is missing: $webDistPath"
}

$apiPort = [int](Get-ConfiguredValue 'API_PORT' '8787')
if ($apiPort -lt 1 -or $apiPort -gt 65535) {
  throw 'API_PORT must be a number between 1 and 65535.'
}

if (Test-Path -LiteralPath $statePath) {
  $state = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
  if ($null -ne (Get-ManagedProcess ([int]$state.appProcessId) $serverScriptPath)) {
    Write-Status "The release service is already running at http://localhost:$($state.apiPort)"
    exit 0
  }
  Remove-Item -LiteralPath $statePath -Force
}

Assert-PortAvailable $apiPort
New-Item -ItemType Directory -Force -Path $runtimeRoot, $logRoot | Out-Null

$env:WEB_DIST_DIR = $webDistPath
$env:WEB_ORIGIN = "http://localhost:$apiPort"

Write-Status 'Checking the MySQL connection.'
Invoke-NodeScript $databaseCheckPath
Write-Status 'Checking data, resource, and backup paths.'
Invoke-NodeScript $storageCheckPath

$stdoutPath = Join-Path $logRoot 'release.out.log'
$stderrPath = Join-Path $logRoot 'release.error.log'
$argument = "`"$serverScriptPath`""

Write-Status 'Starting the production API and Web service.'
$process = Start-Process -FilePath $nodePath -ArgumentList @($argument) -WorkingDirectory $projectRoot -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -WindowStyle Hidden -PassThru
$state = [ordered]@{
  appProcessId = $process.Id
  startedAt = (Get-Date).ToUniversalTime().ToString('o')
  apiPort = $apiPort
  webUrl = "http://localhost:$apiPort/"
  outputLog = $stdoutPath
  errorLog = $stderrPath
  nodeVersion = (& $nodePath --version).Trim()
}
$state | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding utf8

$ready = $false
for ($attempt = 1; $attempt -le 30; $attempt++) {
  Start-Sleep -Milliseconds 500
  if ($null -eq (Get-ManagedProcess $process.Id $serverScriptPath)) {
    break
  }
  if ((Test-HttpEndpoint "http://127.0.0.1:$apiPort/api/health") -and (Test-HttpEndpoint "http://127.0.0.1:$apiPort/")) {
    $ready = $true
    break
  }
}

if (-not $ready) {
  Stop-ProcessTree $process.Id $serverScriptPath
  Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue
  throw "The production service failed to start. Check the log: $stderrPath"
}

Write-Status 'The production service is running.'
Write-Status "URL: http://localhost:$apiPort/"
Write-Status "Fixed Node.js: $($state.nodeVersion)"
Write-Status "Stop command: powershell -ExecutionPolicy Bypass -File `"$(Join-Path $projectRoot 'stop-release.ps1')`""
