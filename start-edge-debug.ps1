<#
  start-edge-debug.ps1 — 让 Edge 打开远程调试口（9222）

  重要（Edge 153 实测）：
    · 传入 --remote-debugging-port 后，Edge 会**忽略它**（若用的是默认用户数据目录）——这是
      Chromium 136+ 的安全加固：默认 profile 不允许远程调试。端口不会开、DevToolsActivePort 也不会写。
    · 可行路线是用 Edge 自带的开关：edge://inspect/#remote-debugging 里的「远程调试」，
      开启时 Edge 会问一次「是否允许」→ 点允许。之后同一 Edge 会话内不再需要点。
    · 脚本会把这一步的页面直接打开，你只需要在页面上把开关打开。

  用法：
    powershell -ExecutionPolicy Bypass -File .\start-edge-debug.ps1            # 需要 Edge 已完全退出
    powershell -ExecutionPolicy Bypass -File .\start-edge-debug.ps1 -Restart   # 由脚本先强退 Edge
#>
param(
  [switch]$Restart,
  [int]$Port = 9222,
  [string]$Url = "https://yjsxk.sjtu.edu.cn/yjsxkapp/sys/xsxkapp/course.html"
)

$ErrorActionPreference = "Continue"

function Test-Port {
  param([int]$P)
  try {
    $c = New-Object System.Net.Sockets.TcpClient
    $null = $c.Connect("127.0.0.1", $P)
    $c.Close()
    return $true
  } catch { return $false }
}

$candidates = @(
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe"
)
$exe = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $exe) { Write-Host "✗ 找不到 msedge.exe" -ForegroundColor Red; exit 1 }
Write-Host "Edge: $exe"

$portFile = "$env:LOCALAPPDATA\Microsoft\Edge\User Data\DevToolsActivePort"

# 已经开着调试口就直接用
if (Test-Port $Port) {
  Write-Host "✓ $Port 端口已经在监听，无需重启 Edge。" -ForegroundColor Green
  exit 0
}

$running = Get-Process msedge -ErrorAction SilentlyContinue
if ($running -and -not $Restart) {
  Write-Host "✗ Edge 正在运行（$($running.Count) 个进程），但 $Port 未开启。" -ForegroundColor Yellow
  Write-Host "  两种做法："
  Write-Host "  A) 在 Edge 里打开 edge://inspect/#remote-debugging，打开「远程调试」开关并点『允许』（推荐，不用关浏览器）"
  Write-Host "  B) 完全退出 Edge 后重跑本脚本，或加 -Restart 让脚本强制结束 Edge"
  exit 1
}

if ($running -and $Restart) {
  Write-Host "强制结束 Edge 进程（-Restart）…" -ForegroundColor Yellow
  Stop-Process -Name msedge -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 4
}

if (Test-Path $portFile) { Remove-Item $portFile -Force -ErrorAction SilentlyContinue }

Write-Host "启动 Edge（--remote-debugging-port=$Port --restore-last-session）并打开远程调试设置页…"
Start-Process -FilePath $exe -ArgumentList "--remote-debugging-port=$Port", "--restore-last-session", "edge://inspect/#remote-debugging", $Url

for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Milliseconds 1000
  if (Test-Port $Port) {
    Write-Host "✓ $Port 已监听，远程调试可用。" -ForegroundColor Green
    Write-Host "  下一步：node monitor.mjs --dry"
    exit 0
  }
}

Write-Host "⚠ $Port 仍未监听。" -ForegroundColor Yellow
Write-Host "  Edge 153 用默认用户数据目录时会忽略 --remote-debugging-port（安全加固）。"
Write-Host "  请在刚打开的 edge://inspect/#remote-debugging 页面里："
Write-Host "    1) 打开「远程调试 / Remote debugging」开关；"
Write-Host "    2) Edge 弹出「是否允许远程调试」时点『允许』。"
Write-Host "  然后重跑本脚本（会检测到端口已开并直接退出），或直接跑：node monitor.mjs --dry"
exit 2
