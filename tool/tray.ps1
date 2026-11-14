param(
  [string]$Root = '',
  [string]$Node = 'node'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$root = if ($Root) { $Root } else { Split-Path -Parent $PSScriptRoot }
$bin = Join-Path $root 'tool\bin\convledger.mjs'
$ico = Join-Path $root 'tool\web\convledger.ico'

# A single tray icon per user session. A second launcher exits quietly.
$mutex = New-Object System.Threading.Mutex($false, 'Local\ConvLedgerTray')
if (-not $mutex.WaitOne(0)) { exit 0 }

$openLabel = [string]([char]0x6253) + [string]([char]0x5F00)
$restartLabel = [string]([char]0x91CD) + [string]([char]0x542F)
$exitLabel = [string]([char]0x9000) + [string]([char]0x51FA)

function AppWindows {
  try {
    return Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" |
      Where-Object { $_.CommandLine -match 'app-profile' } |
      ForEach-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue } |
      Where-Object { $_ -and $_.MainWindowHandle -ne 0 }
  } catch { return @() }
}

function Start-App {
  try {
    $env:CONVLEDGER_NO_TRAY = '1'
    Start-Process -FilePath $Node -ArgumentList @($bin, 'app') -WorkingDirectory $root -WindowStyle Hidden
  } catch { }
}

function Stop-AppWindow {
  foreach ($p in (AppWindows)) {
    try { $p.CloseMainWindow() | Out-Null } catch { }
  }
}

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$openItem = $menu.Items.Add($openLabel)
$restartItem = $menu.Items.Add($restartLabel)
$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null
$exitItem = $menu.Items.Add($exitLabel)

$ni = New-Object System.Windows.Forms.NotifyIcon
try { $ni.Icon = New-Object System.Drawing.Icon($ico) }
catch { $ni.Icon = [System.Drawing.SystemIcons]::Application }
$ni.Text = 'convledger · 制作人 再来一杯海星酒'
$ni.ContextMenuStrip = $menu
$ni.Visible = $true

$openItem.add_Click({ Start-App })
$restartItem.add_Click({ Stop-AppWindow; Start-Sleep -Milliseconds 800; Start-App })
$exitItem.add_Click({
  Stop-AppWindow
  $ni.Visible = $false
  $ni.Dispose()
  $ctx.ExitThread()
})
$ni.add_MouseClick({
  param($sender, $e)
  if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Start-App }
})

$ctx = New-Object System.Windows.Forms.ApplicationContext
[System.Windows.Forms.Application]::Run($ctx)
