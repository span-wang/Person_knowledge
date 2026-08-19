[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$runtimeRoot = Join-Path $projectRoot '.runtime'
$statePath = Join-Path $runtimeRoot 'process.json'
$devScriptPath = Join-Path $projectRoot 'scripts\dev.mjs'

function Write-Status([string]$Message) {
  Write-Host "[personal_workspace] $Message"
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
  Write-Status '没有找到本项目的运行记录，未停止其他进程。'
  exit 0
}

$state = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
$appProcessId = [int]$state.appProcessId
$appProcess = Get-ManagedProcess $appProcessId $devScriptPath
$tunnelProcess = $null
if ($null -ne $state.tunnelProcessId -and $null -ne $state.tunnelCommand) {
  $tunnelProcess = Get-ManagedProcess ([int]$state.tunnelProcessId) ([string]$state.tunnelCommand)
}

if ($null -eq $appProcess -and $null -eq $tunnelProcess) {
  Remove-Item -LiteralPath $statePath -Force
  Write-Status '受管进程已不存在，已清理运行记录。'
  exit 0
}

$taskkillPath = Join-Path $env:SystemRoot 'System32\taskkill.exe'
if ($null -ne $tunnelProcess) {
  $tunnelProcessId = [int]$state.tunnelProcessId
  Write-Status "停止 Cloudflare Tunnel，进程号 $tunnelProcessId。"
  & $taskkillPath /PID $tunnelProcessId /T /F | Out-Null
}
if ($null -ne $appProcess) {
  Write-Status "停止本项目 API 与 Web 进程树，根进程号 $appProcessId。"
  & $taskkillPath /PID $appProcessId /T /F | Out-Null
}
Start-Sleep -Milliseconds 500

if ($null -ne $appProcess -and $null -ne (Get-ManagedProcess $appProcessId $devScriptPath)) {
  throw "应用进程 $appProcessId 未能停止，请查看运行权限。"
}
if ($null -ne $tunnelProcess -and $null -ne (Get-ManagedProcess ([int]$state.tunnelProcessId) ([string]$state.tunnelCommand))) {
  throw "Cloudflare Tunnel 进程 $($state.tunnelProcessId) 未能停止，请查看运行权限。"
}

Remove-Item -LiteralPath $statePath -Force
Write-Status 'API、Web 与 Cloudflare Tunnel 已停止，MySQL 未停止。'
