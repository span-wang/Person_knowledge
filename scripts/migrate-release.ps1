[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$scriptRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$projectRoot = if (Test-Path -LiteralPath (Join-Path $scriptRoot 'apps\api\dist')) { $scriptRoot } else { [IO.Path]::GetFullPath((Join-Path $scriptRoot '..')) }
$nodePath = Join-Path $projectRoot 'runtime\node\node.exe'
$migrationPath = Join-Path $projectRoot 'apps\api\dist\migrate.js'

if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) {
  throw "The fixed Node.js runtime is missing: $nodePath"
}
if (-not (Test-Path -LiteralPath $migrationPath -PathType Leaf)) {
  throw "The database migration output is missing: $migrationPath"
}

Set-Location -LiteralPath $projectRoot
& $nodePath $migrationPath
if ($LASTEXITCODE -ne 0) {
  throw 'Database migration failed. Check the MySQL settings in .env.'
}
