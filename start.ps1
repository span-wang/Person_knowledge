[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$runtimeRoot = Join-Path $projectRoot '.runtime'
$statePath = Join-Path $runtimeRoot 'process.json'
$logRoot = Join-Path $runtimeRoot 'logs'
$devScriptPath = Join-Path $projectRoot 'scripts\dev.mjs'

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

try {
  $apiPort = [int](Get-ConfiguredValue 'API_PORT' '8787')
  $webPort = [int](Get-ConfiguredValue 'WEB_PORT' '5173')
} catch {
  throw 'API_PORT 和 WEB_PORT 必须是有效端口号。'
}
if ($apiPort -lt 1 -or $apiPort -gt 65535 -or $webPort -lt 1 -or $webPort -gt 65535) {
  throw 'API_PORT 和 WEB_PORT 必须是 1 到 65535 之间的端口号。'
}

function Get-ConfiguredBoolean([string]$Name, [string]$Fallback) {
  $value = Get-ConfiguredValue $Name $Fallback
  switch ($value.ToLowerInvariant()) {
    'true' { return $true }
    'false' { return $false }
    default { throw "$Name 只能设置为 true 或 false。" }
  }
}

function Resolve-ProjectPath([string]$ConfiguredPath) {
  if ([IO.Path]::IsPathRooted($ConfiguredPath)) {
    return [IO.Path]::GetFullPath($ConfiguredPath)
  }

  return [IO.Path]::GetFullPath((Join-Path $projectRoot $ConfiguredPath))
}

$tunnelEnabled = Get-ConfiguredBoolean 'CLOUDFLARED_ENABLED' 'false'
$publicAccessReady = Get-ConfiguredBoolean 'PUBLIC_ACCESS_READY' 'false'
$tunnelName = Get-ConfiguredValue 'CLOUDFLARED_TUNNEL_NAME' ''
$tunnelPublicUrl = Get-ConfiguredValue 'CLOUDFLARED_PUBLIC_URL' 'https://review.panspan.cloud'
$tunnelConfigPath = $null
$tunnelCredentialsPath = $null
$cloudflaredPath = $null
if ($tunnelEnabled) {
  if (-not $publicAccessReady) {
    throw '公网安全门禁尚未完成，拒绝启动 Cloudflare Tunnel。'
  }

  $tunnelConfigPath = Resolve-ProjectPath (Get-ConfiguredValue 'CLOUDFLARED_CONFIG' '.\\cloudflared\\config.yml')
  if (-not (Test-Path -LiteralPath $tunnelConfigPath)) {
    throw "未找到 Cloudflare Tunnel 配置文件：$tunnelConfigPath"
  }

  $tunnelCredentialsPath = Resolve-ProjectPath (Get-ConfiguredValue 'CLOUDFLARED_CREDENTIALS_FILE' '.\cloudflared\tunnel-credentials.json')
  if (-not (Test-Path -LiteralPath $tunnelCredentialsPath -PathType Leaf)) {
    throw "未找到 Cloudflare Tunnel 凭证文件：$tunnelCredentialsPath。凭证只应保存在本机。"
  }

  $parsedTunnelUrl = $null
  if (-not [Uri]::TryCreate($tunnelPublicUrl, [UriKind]::Absolute, [ref]$parsedTunnelUrl) -or
      $parsedTunnelUrl.Scheme -ne 'https' -or
      $parsedTunnelUrl.Host -ne 'review.panspan.cloud') {
    throw 'CLOUDFLARED_PUBLIC_URL 必须是 https://review.panspan.cloud。'
  }

  $configuredBinary = Get-ConfiguredValue 'CLOUDFLARED_BIN' 'cloudflared.exe'
  $binaryInProject = Resolve-ProjectPath $configuredBinary
  if (Test-Path -LiteralPath $binaryInProject) {
    $cloudflaredPath = $binaryInProject
  } else {
    $cloudflaredCommand = Get-Command $configuredBinary -ErrorAction SilentlyContinue
    if ($null -eq $cloudflaredCommand) {
      throw '未找到 cloudflared，请配置 CLOUDFLARED_BIN 或将其加入 PATH。'
    }
    $cloudflaredPath = $cloudflaredCommand.Source
  }

  $validationOutput = @(& $cloudflaredPath tunnel --config $tunnelConfigPath ingress validate 2>&1)
  if ($LASTEXITCODE -ne 0) {
    $validationDetails = ($validationOutput -join [Environment]::NewLine).Trim()
    if ([string]::IsNullOrWhiteSpace($validationDetails)) {
      $validationDetails = '没有返回具体错误。'
    }
    throw "Cloudflare Tunnel 配置校验失败：$validationDetails"
  }
}

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

function Remove-StaleState {
  if (Test-Path -LiteralPath $statePath) {
    $state = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
    $appProcess = Get-ManagedProcess ([int]$state.appProcessId) $devScriptPath
    $tunnelProcess = $null
    if ($null -ne $state.tunnelProcessId -and $null -ne $state.tunnelCommand) {
      $tunnelProcess = Get-ManagedProcess ([int]$state.tunnelProcessId) ([string]$state.tunnelCommand)
    }

    if ($null -ne $appProcess -or $null -ne $tunnelProcess) {
      if ($null -ne $appProcess -and $tunnelEnabled -and $null -eq $tunnelProcess) {
        Write-Status '应用已运行但 Cloudflare Tunnel 未运行，补启动受管 Tunnel。'
        Start-ConfiguredTunnel $state ([int]$state.appProcessId)
        $tunnelProcess = Get-ManagedProcess ([int]$state.tunnelProcessId) ([string]$state.tunnelCommand)
      }

      Write-Status "服务已运行，应用进程号 $($state.appProcessId)。"
      Write-Status "Web：http://127.0.0.1:$($state.webPort)"
      if ($null -ne $tunnelProcess) {
        Write-Status "Cloudflare Tunnel 正在运行，进程号 $($state.tunnelProcessId)。"
      }
      return $true
    }

    Remove-Item -LiteralPath $statePath -Force
  }

  return $false
}

function Invoke-ProjectCommand([string[]]$Arguments) {
  & $npmPath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "命令执行失败：npm $($Arguments -join ' ')"
  }
}

function Test-HttpEndpoint([string]$Uri) {
  try {
    $response = Invoke-WebRequest -Uri $Uri -TimeoutSec 2 -UseBasicParsing
    return $response.StatusCode -eq 200
  } catch {
    return $false
  }
}

function Assert-PortAvailable([int]$Port, [string]$ServiceName) {
  $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
  if ($listeners.Count -eq 0) {
    return
  }

  $processIds = $listeners | Select-Object -ExpandProperty OwningProcess -Unique
  throw "$ServiceName 端口 $Port 已被未受管进程占用（进程号：$($processIds -join ', ')）。请先确认该进程，脚本不会停止它。"
}

function Stop-ProcessTree([int]$ProcessId, [string]$Marker) {
  $processInfo = Get-ManagedProcess $ProcessId $Marker
  if ($null -eq $processInfo) {
    return
  }

  $taskkillPath = Join-Path $env:SystemRoot 'System32\taskkill.exe'
  & $taskkillPath /PID $ProcessId /T /F | Out-Null
}

function Set-StateValue([object]$State, [string]$Name, [object]$Value) {
  if ($State -is [System.Collections.IDictionary]) {
    $State[$Name] = $Value
    return
  }

  $property = $State.PSObject.Properties[$Name]
  if ($null -eq $property) {
    $State | Add-Member -NotePropertyName $Name -NotePropertyValue $Value
  } else {
    $State.$Name = $Value
  }
}

function Start-ConfiguredTunnel([object]$State, [int]$AppProcessId, [switch]$StopAppOnFailure) {
  $tunnelOutputPath = Join-Path $logRoot 'cloudflared.out.log'
  $tunnelErrorPath = Join-Path $logRoot 'cloudflared.error.log'
  $tunnelArguments = @('tunnel', '--config', "`"$tunnelConfigPath`"", 'run')
  if (-not [string]::IsNullOrWhiteSpace($tunnelName)) {
    $tunnelArguments += $tunnelName
  }

  $tunnelProcess = $null
  try {
    Write-Status '启动 Cloudflare Tunnel。'
    $tunnelProcess = Start-Process -FilePath $cloudflaredPath -ArgumentList $tunnelArguments -WorkingDirectory $projectRoot -RedirectStandardOutput $tunnelOutputPath -RedirectStandardError $tunnelErrorPath -WindowStyle Hidden -PassThru
    Set-StateValue $State 'tunnelProcessId' $tunnelProcess.Id
    Set-StateValue $State 'tunnelCommand' $tunnelConfigPath
    Set-StateValue $State 'tunnelPublicUrl' $tunnelPublicUrl
    Set-StateValue $State 'tunnelOutputLog' $tunnelOutputPath
    Set-StateValue $State 'tunnelErrorLog' $tunnelErrorPath
    $State | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding utf8
    Start-Sleep -Seconds 1

    if ($null -eq (Get-ManagedProcess $tunnelProcess.Id $tunnelConfigPath)) {
      throw 'Cloudflare Tunnel 进程未保持运行。'
    }
  } catch {
    if ($null -ne $tunnelProcess) {
      Stop-ProcessTree $tunnelProcess.Id $tunnelConfigPath
    }

    Set-StateValue $State 'tunnelProcessId' $null
    Set-StateValue $State 'tunnelCommand' $null
    Set-StateValue $State 'tunnelPublicUrl' $null
    Set-StateValue $State 'tunnelOutputLog' $null
    Set-StateValue $State 'tunnelErrorLog' $null
    if ($StopAppOnFailure) {
      Stop-ProcessTree $AppProcessId $devScriptPath
      Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue
    } else {
      $State | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding utf8
    }

    throw "Cloudflare Tunnel 启动失败，请查看日志：$tunnelErrorPath"
  }
}

if (Remove-StaleState) {
  exit 0
}

$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
$npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
if ($null -eq $nodeCommand) {
  throw '未找到 Node.js，请先安装 Node.js 22 或更高版本。'
}
if ($null -eq $npmCommand) {
  throw '未找到 npm.cmd，请检查 Node.js 安装是否完整。'
}

$nodePath = $nodeCommand.Source
$npmPath = $npmCommand.Source
if (-not (Test-Path -LiteralPath $devScriptPath)) {
  throw "未找到开发启动脚本：$devScriptPath"
}

Set-Location -LiteralPath $projectRoot
New-Item -ItemType Directory -Force -Path $runtimeRoot, $logRoot | Out-Null

Write-Status '检查 MySQL 连接。'
Invoke-ProjectCommand @('--silent', 'run', 'db:check')
Write-Status '检查数据、资源和备份路径。'
Invoke-ProjectCommand @('--silent', 'run', 'storage:check')
Write-Status '构建共享类型。'
Invoke-ProjectCommand @('--silent', 'run', 'build:shared')

$apiUri = "http://127.0.0.1:$apiPort/api/health"
  $webUri = "http://127.0.0.1:$webPort/"
Assert-PortAvailable $apiPort 'API'
Assert-PortAvailable $webPort 'Web'
$stdoutPath = Join-Path $logRoot 'dev.out.log'
$stderrPath = Join-Path $logRoot 'dev.error.log'
$argument = "`"$devScriptPath`""

Write-Status '启动 API 与 Web 开发服务。'
$devProcess = Start-Process -FilePath $nodePath -ArgumentList @($argument) -WorkingDirectory $projectRoot -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -WindowStyle Hidden -PassThru
$state = [ordered]@{
  appProcessId = $devProcess.Id
  tunnelProcessId = $null
  tunnelCommand = $null
  startedAt = (Get-Date).ToUniversalTime().ToString('o')
  apiPort = $apiPort
  webPort = $webPort
  outputLog = $stdoutPath
  errorLog = $stderrPath
}
$state | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding utf8

$ready = $false
for ($attempt = 1; $attempt -le 30; $attempt++) {
  Start-Sleep -Milliseconds 500
  if ($null -eq (Get-ManagedProcess $devProcess.Id $devScriptPath)) {
    break
  }
  if ((Test-HttpEndpoint $apiUri) -and (Test-HttpEndpoint $webUri)) {
    $ready = $true
    break
  }
}

if (-not $ready) {
  Stop-ProcessTree $devProcess.Id $devScriptPath
  Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue
  throw "服务启动失败，请查看日志：$stderrPath"
}

if ($tunnelEnabled) {
  Start-ConfiguredTunnel $state $devProcess.Id -StopAppOnFailure
}

Write-Status '服务已启动。'
Write-Status "API：$apiUri"
Write-Status "Web：$webUri"
if ($tunnelEnabled) {
  Write-Status "Cloudflare Tunnel 已启动，进程号 $($state.tunnelProcessId)。"
  Write-Status "公网地址：$tunnelPublicUrl"
} else {
  Write-Status 'Cloudflare Tunnel 未启动（CLOUDFLARED_ENABLED=false）。'
}
Write-Status "停止命令：powershell -ExecutionPolicy Bypass -File `"$(Join-Path $projectRoot 'stop.ps1')`""
