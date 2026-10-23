$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding

try {
  $projectRoot = Split-Path -Parent $PSScriptRoot
  Set-Location -LiteralPath $projectRoot

  $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $nodeCommand) {
    throw '未找到 Node.js。请先安装 Node.js 24，再双击启动。'
  }
  $nodeVersionText = & $nodeCommand.Source -p 'process.versions.node'
  if ($LASTEXITCODE -ne 0 -or [version]$nodeVersionText -lt [version]'22.12.0') {
    throw 'Node.js 版本过低，需要 22.12.0 或以上，建议使用 24.7.0。'
  }
  $pnpmCommand = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
  if (-not $pnpmCommand) {
    throw '未找到 pnpm。请先运行 npm install -g pnpm@11.22.0，再双击启动。'
  }

  Write-Host '[1/3] 检查并同步项目依赖...'
  & $pnpmCommand.Source install --frozen-lockfile --prefer-offline
  if ($LASTEXITCODE -ne 0) { throw '依赖同步失败，请查看上方错误。' }

  Write-Host '[2/3] 构建 AgentDeck...'
  & $pnpmCommand.Source build
  if ($LASTEXITCODE -ne 0) { throw '项目构建失败，请查看上方错误。' }

  $env:NODE_ENV = 'production'
  # Port zero delegates selection to Windows, including its port exclusion rules.
  if ([string]::IsNullOrWhiteSpace($env:PORT)) { $env:PORT = '0' }
  if ([string]::IsNullOrWhiteSpace($env:AGENTDECK_OPEN_BROWSER)) {
    $env:AGENTDECK_OPEN_BROWSER = '1'
  }
  Write-Host '[3/3] 启动本机服务，稍后会自动打开浏览器。'
  if ($env:PORT -eq '0') {
    Write-Host '由系统自动选择可用端口；连接地址将显示在下方。'
  } else {
    Write-Host "使用环境变量 PORT 指定的端口：$env:PORT"
  }
  Write-Host '请保留此窗口；关闭窗口即可停止服务。'
  Write-Host ''
  & $nodeCommand.Source (Join-Path $projectRoot 'apps/server/dist/index.js')
  if ($LASTEXITCODE -ne 0) {
    throw '服务启动失败。若提示 EACCES 或 EADDRINUSE，指定端口可能被系统保留或已被占用；清除 PORT 环境变量后可自动选择可用端口。'
  }
} catch {
  Write-Host ''
  Write-Host "[错误] $($_.Exception.Message)" -ForegroundColor Red
  Read-Host '按回车关闭窗口'
  exit 1
}
exit 0
