[CmdletBinding()]
param(
  [string]$OutputDirectory = '',
  [string]$NodeRuntimePath = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
  $outputRoot = Join-Path $projectRoot 'output\windows-release'
} elseif ([IO.Path]::IsPathRooted($OutputDirectory)) {
  $outputRoot = [IO.Path]::GetFullPath($OutputDirectory)
} else {
  $outputRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot $OutputDirectory))
}
if ($outputRoot -eq $projectRoot) {
  throw 'The package output directory cannot be the project root.'
}

function Write-Status([string]$Message) {
  Write-Host "[package-windows] $Message"
}

function Invoke-External([string]$FilePath, [string[]]$Arguments, [string]$FailureMessage) {
  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw $FailureMessage
  }
}

$npmCommand = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
if ([string]::IsNullOrWhiteSpace($npmCommand)) {
  throw 'npm.cmd is required to build the package; the target computer does not need npm.'
}

if ([string]::IsNullOrWhiteSpace($NodeRuntimePath)) {
  $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($null -eq $nodeCommand) {
    throw 'Node.js was not found. Use -NodeRuntimePath to select a fixed Node.js directory or node.exe.'
  }
  $nodeSource = $nodeCommand.Source
} elseif (Test-Path -LiteralPath $NodeRuntimePath -PathType Container) {
  $nodeSource = Join-Path ([IO.Path]::GetFullPath($NodeRuntimePath)) 'node.exe'
} else {
  $nodeSource = [IO.Path]::GetFullPath($NodeRuntimePath)
}

if (-not (Test-Path -LiteralPath $nodeSource -PathType Leaf)) {
  throw "The fixed Node.js executable was not found: $nodeSource"
}

$nodeVersion = (& $nodeSource --version).Trim()
$versionMatch = [regex]::Match($nodeVersion, '^v(?<major>\d+)')
if (-not $versionMatch.Success -or [int]$versionMatch.Groups['major'].Value -lt 22) {
  throw "The fixed Node.js version must be 22 or newer, but is $nodeVersion."
}

Write-Status "Using fixed Node.js $nodeVersion."
Set-Location -LiteralPath $projectRoot
Write-Status 'Building shared types, Web, and API.'
Invoke-External $npmCommand @('run', 'build') 'The project build failed; no package was generated.'

$requiredPaths = @(
  (Join-Path $projectRoot 'apps\api\dist\server.js'),
  (Join-Path $projectRoot 'apps\api\dist\migrate.js'),
  (Join-Path $projectRoot 'apps\web\dist\index.html'),
  (Join-Path $projectRoot 'packages\shared\dist\index.js')
)
foreach ($requiredPath in $requiredPaths) {
  if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
    throw "A build output is missing: $requiredPath"
  }
}

if (Test-Path -LiteralPath $outputRoot) {
  Write-Status "Removing the old package: $outputRoot"
  Remove-Item -LiteralPath $outputRoot -Recurse -Force
}

$directories = @(
  $outputRoot,
  (Join-Path $outputRoot 'apps\api'),
  (Join-Path $outputRoot 'apps\web'),
  (Join-Path $outputRoot 'packages\shared'),
  (Join-Path $outputRoot 'database\migrations'),
  (Join-Path $outputRoot 'runtime\node'),
  (Join-Path $outputRoot 'data'),
  (Join-Path $outputRoot 'resources'),
  (Join-Path $outputRoot 'backups'),
  (Join-Path $outputRoot '.runtime')
)
foreach ($directory in $directories) {
  New-Item -ItemType Directory -Force -Path $directory | Out-Null
}

Write-Status 'Copying build output and configuration templates.'
Copy-Item -LiteralPath (Join-Path $projectRoot 'apps\api\dist') -Destination (Join-Path $outputRoot 'apps\api\dist') -Recurse
Copy-Item -LiteralPath (Join-Path $projectRoot 'apps\web\dist') -Destination (Join-Path $outputRoot 'apps\web\dist') -Recurse
Copy-Item -LiteralPath (Join-Path $projectRoot 'packages\shared\dist') -Destination (Join-Path $outputRoot 'packages\shared\dist') -Recurse
Copy-Item -LiteralPath (Join-Path $projectRoot 'packages\shared\package.json') -Destination (Join-Path $outputRoot 'packages\shared\package.json')
Copy-Item -LiteralPath (Join-Path $projectRoot 'database\migrations') -Destination (Join-Path $outputRoot 'database\migrations') -Recurse
Copy-Item -LiteralPath (Join-Path $projectRoot '.env.example') -Destination (Join-Path $outputRoot '.env.example')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'start-release.ps1') -Destination (Join-Path $outputRoot 'start-release.ps1')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'stop-release.ps1') -Destination (Join-Path $outputRoot 'stop-release.ps1')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'migrate-release.ps1') -Destination (Join-Path $outputRoot 'migrate-release.ps1')

$apiPackage = Get-Content -Raw -LiteralPath (Join-Path $projectRoot 'apps\api\package.json') | ConvertFrom-Json
$releaseDependencies = [ordered]@{}
foreach ($dependency in $apiPackage.dependencies.PSObject.Properties) {
  $releaseDependencies[$dependency.Name] = [string]$dependency.Value
}
$releaseDependencies['@knowledge-flashcards/shared'] = 'file:packages/shared'
$releaseManifest = [ordered]@{
  name = 'knowledge-flashcards-windows-release'
  version = [string]$apiPackage.version
  private = $true
  type = 'module'
  dependencies = $releaseDependencies
}
$releaseManifest | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $outputRoot 'package.json') -Encoding utf8

Write-Status 'Installing production dependencies.'
Push-Location -LiteralPath $outputRoot
try {
  Invoke-External $npmCommand @('install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund') 'Production dependency installation failed.'
} finally {
  Pop-Location
}

Write-Status 'Copying the fixed Node.js runtime.'
Copy-Item -LiteralPath $nodeSource -Destination (Join-Path $outputRoot 'runtime\node\node.exe')
$nodeLicense = Get-ChildItem -LiteralPath (Split-Path -Parent $nodeSource) -Filter 'LICENSE*' -File -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -ne $nodeLicense) {
  Copy-Item -LiteralPath $nodeLicense.FullName -Destination (Join-Path $outputRoot "runtime\node\$($nodeLicense.Name)")
}
$nodeVersion | Set-Content -LiteralPath (Join-Path $outputRoot 'runtime\node-version.txt') -Encoding ascii

$startCmd = @'
@echo off
setlocal
cd /d "%~dp0"

"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-release.ps1"
set "exitCode=%errorlevel%"

echo.
if not "%exitCode%"=="0" (
  echo Startup failed. Review the errors above and .runtime\logs.
) else (
  echo Release service started. Closing this window will not stop it.
)
echo Press any key to close this window.
pause >nul
exit /b %exitCode%
'@
$stopCmd = @'
@echo off
setlocal
cd /d "%~dp0"

"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-release.ps1"
set "exitCode=%errorlevel%"

echo.
if not "%exitCode%"=="0" (
  echo Stop failed. Review the errors above.
) else (
  echo Release service stopped. MySQL is still running.
)
echo Press any key to close this window.
pause >nul
exit /b %exitCode%
'@
$migrateCmd = @'
@echo off
setlocal
cd /d "%~dp0"

"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0migrate-release.ps1"
set "exitCode=%errorlevel%"

echo.
if not "%exitCode%"=="0" (
  echo Database migration failed. Review .env and the MySQL service.
) else (
  echo Database migration completed.
)
echo Press any key to close this window.
pause >nul
exit /b %exitCode%
'@
$startCmd | Set-Content -LiteralPath (Join-Path $outputRoot 'start.cmd') -Encoding ascii
$stopCmd | Set-Content -LiteralPath (Join-Path $outputRoot 'stop.cmd') -Encoding ascii
$migrateCmd | Set-Content -LiteralPath (Join-Path $outputRoot 'migrate.cmd') -Encoding ascii

$readme = @"
Knowledge Flashcards Windows release package

1. Copy .env.example to .env and fill in the MySQL settings and AI_PROVIDER_KEY_ENCRYPTION_SECRET.
2. Make sure MySQL is running. On a new database, run migrate.cmd once.
3. Run start.cmd and open http://localhost:8787/ (change API_PORT in .env if needed).
4. Run stop.cmd to stop this package. MySQL is not stopped by the script.

This package includes fixed Node.js $nodeVersion and production dependencies. The target computer does not need Node.js, npm, TypeScript, or Vite.
This package does not include the database, user data, resources, backups, .env, Cloudflare credentials, or API keys.
"@
$readme | Set-Content -LiteralPath (Join-Path $outputRoot 'README-WINDOWS.txt') -Encoding utf8

$manifest = [ordered]@{
  package = 'knowledge-flashcards-windows-release'
  version = [string]$apiPackage.version
  nodeVersion = $nodeVersion
  entrypoint = 'apps/api/dist/server.js'
  webDist = 'apps/web/dist'
  runtime = 'runtime/node/node.exe'
  generatedAt = (Get-Date).ToUniversalTime().ToString('o')
}
$manifest | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $outputRoot 'release-manifest.json') -Encoding utf8

Write-Status "Package generated: $outputRoot"
Write-Status 'The package does not include .env, user data, resources, backups, or Cloudflare credentials.'
