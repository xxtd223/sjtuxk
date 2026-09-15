<#
  start-edge-debug.ps1 — 让 Edge 打开远程调试口（9222）

  检测逻辑：先 TCP 探端口，再用 Node 真连一次 WebSocket 握手 ——
  只有握手成功才算「调试可用」（端口在听但握手被拒 = 授权失效，需重新开关）。

  用法：
    powershell -ExecutionPolicy Bypass -File .\start-edge-debug.ps1
    powershell -ExecutionPolicy Bypass -File .\start-edge-debug.ps1 -Restart   # 先强退 Edge 再启动
#>
param(
  [switch]$Restart,
  [int]$Port = 9222,
  [string]$Url = "https://yjsxk.sjtu.edu.cn/yjsxkapp/sys/xsxkapp/course.html"
)

$ErrorActionPreference = "Continue"
$HERE = Split-Path -Parent $MyInvocation.MyCommand.Path
$portFile = "$env:LOCALAPPDATA\Microsoft\Edge\User Data\DevToolsActivePort"

function Test-TcpPort {
  param([int]$P)
  try { $c = New-Object System.Net.Sockets.TcpClient; $null = $c.Connect("127.0.0.1", $P); $c.Close(); return $true }
  catch { return $false }
}

# 真握手：用项目自带的 CDP 客户端连一次
function Test-CdpHandshake {
  $code = "import('./cdp.mjs').then(async ({connect})=>{try{const c=await connect(8000,1);await c.pages();c.close();console.log('WS_OK')}catch(e){console.log('WS_FAIL')}}).catch(()=>console.log('WS_FAIL'))"
  $out = & node -e $code 2>&1
  return ($out -join " ") -match "WS_OK"
}

if (Test-CdpHandshake) {
  Write-Host "✓ 调试可用（WebSocket 握手成功），无需重启 Edge。" -ForegroundColor Green
  exit 0
}

if (Test-TcpPort $Port) {
  Write-Host "⚠ $Port 端口在监听，但 WebSocket 握手被拒（授权很可能已失效）。" -ForegroundColor Yellow
  if (-not $Restart) {
    Write-Host "  先在 Edge 里：打开 edge://inspect/#remote-debugging → 关掉再打开「远程调试」→ 点『允许』；"
    Write-Host "  若仍不行，加 -Restart 重跑本脚本（会先强退 Edge）。"
    exit 1
  }
}

$candidates = @(
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe"
)
$exe = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $exe) { Write-Host "✗ 找不到 msedge.exe" -ForegroundColor Red; exit 1 }
Write-Host "Edge: $exe"

$running = Get-Process msedge -ErrorAction SilentlyContinue
if ($running) {
  if (-not $Restart) {
    Write-Host "✗ Edge 正在运行（$($running.Count) 个进程），但调试口不可用。" -ForegroundColor Yellow
    Write-Host "  做法 A：在 Edge 里打开 edge://inspect/#remote-debugging 拨开「远程调试」并点『允许』（不用关浏览器）"
    Write-Host "  做法 B：完全退出 Edge 后重跑本脚本，或加 -Restart"
    exit 1
  }
  Write-Host "强制结束 Edge 进程（-Restart）…" -ForegroundColor Yellow
  Stop-Process -Name msedge -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 4
}

if (Test-Path $portFile) { Remove-Item $portFile -Force -ErrorAction SilentlyContinue }

# 关键：写 Local State 打开远程调试门禁
#   devtools.remote_debugging.allowed = true（策略层门禁，否则服务根本不会起）
#   devtools.remote_debugging.user-enabled = true（批准模式；它会跳过「默认用户数据目录」限制）
if (Test-Path "$HERE\patch-localstate.mjs") {
  Write-Host "写入 Edge Local State 的远程调试开关（自动备份为 Local State.bak）…"
  & node "$HERE\patch-localstate.mjs" --user-enabled=true | Out-Null
}

Write-Host "启动 Edge（--remote-debugging-port=$Port --restore-last-session）并打开远程调试设置页…"
Start-Process -FilePath $exe -ArgumentList "--remote-debugging-port=$Port", "--restore-last-session", "edge://inspect/#remote-debugging", $Url

for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Milliseconds 1000
  if (Test-CdpHandshake) {
    Write-Host "✓ 调试可用（WebSocket 握手成功）" -ForegroundColor Green
    Write-Host "  下一步：node monitor.mjs --dry"
    exit 0
  }
}

Write-Host "⚠ 调试口仍不可用。" -ForegroundColor Yellow
Write-Host "  Edge 153 用默认用户数据目录时：flag 路线会被安全加固拦住，必须走「批准模式」："
Write-Host "    1) 已自动把 Local State 的 devtools.remote_debugging.allowed / user-enabled 写得 true；"
Write-Host "    2) 确认 Edge 是【完全退出】后由本脚本启动的（Edge 已在运行时带参数启动无效）；"
Write-Host "    3) 启动后在 Edge 里看是否弹「是否允许远程调试」→ 点『允许』，然后重跑本脚本验证。"
exit 2
