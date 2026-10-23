# screenshot-memory Windows tray helper
# Right-click the tray icon to Scan and Index using ssm config.

#requires -Version 5.1
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName Microsoft.VisualBasic

$script:AppName = 'screenshot-memory'
$script:ListsDir = Join-Path $env:LOCALAPPDATA 'screenshot-memory\Data\lists'
$script:JobProcess = $null
$script:JobLogPath = $null
$script:LastExitCode = $null
$script:LastBalloon = ''

function Get-SsmCommand {
    $cmd = Get-Command ssm.cmd -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $cmd = Get-Command ssm -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $fallback = Join-Path $env:USERPROFILE '.bun\bin\ssm.cmd'
    if (Test-Path $fallback) { return $fallback }
    throw "ssm was not found on PATH. Run setup.ps1 first."
}

function Show-Balloon {
    param(
        [string]$Title,
        [string]$Text,
        [ValidateSet('Info', 'Warning', 'Error')]
        [string]$Icon = 'Info',
        [int]$TimeoutMs = 4000
    )
    $script:LastBalloon = $Text
    $toolTipIcon = [System.Windows.Forms.ToolTipIcon]::$Icon
    $notifyIcon.BalloonTipTitle = $Title
    $notifyIcon.BalloonTipText = $Text
    $notifyIcon.BalloonTipIcon = $toolTipIcon
    $notifyIcon.ShowBalloonTip($TimeoutMs)
}

function Test-JobRunning {
    if ($null -eq $script:JobProcess) { return $false }
    try {
        $script:JobProcess.Refresh()
        if ($script:JobProcess.HasExited) {
            try { $script:LastExitCode = $script:JobProcess.ExitCode } catch { $script:LastExitCode = $null }
            $script:JobProcess = $null
            return $false
        }
        return $true
    } catch {
        $script:JobProcess = $null
        return $false
    }
}

function Update-MenuState {
    $running = Test-JobRunning
    $menuScan.Enabled = -not $running
    $menuShow.Enabled = $running -or ($null -ne $script:JobLogPath -and (Test-Path $script:JobLogPath))
    if ($running) {
        $notifyIcon.Text = 'screenshot-memory: indexing...'
    } else {
        $notifyIcon.Text = 'screenshot-memory'
    }
}

function Start-ScanAndIndex {
    if (Test-JobRunning) {
        Show-Balloon -Title $script:AppName -Text 'A Scan and Index run is already in progress.' -Icon Warning
        return
    }

    try {
        $ssm = Get-SsmCommand
    } catch {
        Show-Balloon -Title $script:AppName -Text $_.Exception.Message -Icon Error
        return
    }

    New-Item -ItemType Directory -Path $script:ListsDir -Force | Out-Null
    $stamp = Get-Date -Format 'yyyy-MM-dd'
    $filesPath = Join-Path $script:ListsDir "${stamp}_files.txt"
    $rejectedPath = Join-Path $script:ListsDir "${stamp}_rejected.txt"
    $logPath = Join-Path $script:ListsDir "${stamp}_run.log"
    $script:JobLogPath = $logPath

    $jobScript = Join-Path $env:TEMP "ssm-tray-job-$stamp-$PID.ps1"
    $jobBody = @"
`$ErrorActionPreference = 'Continue'
`$Host.UI.RawUI.WindowTitle = 'screenshot-memory Scan and Index'
`$logPath = @'
$logPath
'@
`$ssm = @'
$ssm
'@
`$filesPath = @'
$filesPath
'@
`$rejectedPath = @'
$rejectedPath
'@
try {
    Start-Transcript -Path `$logPath -Force | Out-Null
} catch {}
Write-Host ''
Write-Host 'screenshot-memory Scan and Index'
Write-Host "Log: `$logPath"
Write-Host ''
& `$ssm scan --out `$filesPath --rejected `$rejectedPath
`$scanCode = `$LASTEXITCODE
if (`$scanCode -ne 0) {
    Write-Host ''
    Write-Host "Scan failed with exit code `$scanCode"
    try { Stop-Transcript | Out-Null } catch {}
    exit `$scanCode
}
Write-Host ''
& `$ssm index --files `$filesPath
`$indexCode = `$LASTEXITCODE
Write-Host ''
if (`$indexCode -eq 0) {
    Write-Host 'Done. You can close this window.'
} else {
    Write-Host "Index failed with exit code `$indexCode"
}
try { Stop-Transcript | Out-Null } catch {}
exit `$indexCode
"@
    Set-Content -Path $jobScript -Value $jobBody -Encoding UTF8

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = 'powershell.exe'
    $psi.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$jobScript`""
    $psi.UseShellExecute = $true
    $psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Normal
    $proc = [System.Diagnostics.Process]::Start($psi)
    if ($null -eq $proc) {
        Show-Balloon -Title $script:AppName -Text 'Could not start the Scan and Index console.' -Icon Error
        return
    }
    $script:JobProcess = $proc
    $script:LastExitCode = $null
    Show-Balloon -Title $script:AppName -Text "Scan and Index started.`nLists: $script:ListsDir" -Icon Info
    Update-MenuState
}

function Show-Progress {
    if (Test-JobRunning) {
        try {
            [Microsoft.VisualBasic.Interaction]::AppActivate($script:JobProcess.Id) | Out-Null
            return
        } catch {
            # Fall through to the log file.
        }
    }
    if ($null -ne $script:JobLogPath -and (Test-Path $script:JobLogPath)) {
        Start-Process -FilePath $script:JobLogPath
        return
    }
    $latest = Get-ChildItem -Path $script:ListsDir -Filter '*_run.log' -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
    if ($latest) {
        Start-Process -FilePath $latest.FullName
        return
    }
    Show-Balloon -Title $script:AppName -Text 'No progress window or log is available yet.' -Icon Warning
}

function Open-ListsFolder {
    New-Item -ItemType Directory -Path $script:ListsDir -Force | Out-Null
    Start-Process -FilePath 'explorer.exe' -ArgumentList $script:ListsDir
}

function Exit-Tray {
    if (Test-JobRunning) {
        Show-Balloon -Title $script:AppName -Text 'Scan and Index is still running. Stop the console first, or wait for it to finish.' -Icon Warning
        return
    }
    $timer.Stop()
    $notifyIcon.Visible = $false
    $notifyIcon.Dispose()
    [System.Windows.Forms.Application]::Exit()
}

# --- UI ---
$menuScan = New-Object System.Windows.Forms.ToolStripMenuItem 'Scan and Index'
$menuShow = New-Object System.Windows.Forms.ToolStripMenuItem 'Show Progress'
$menuLists = New-Object System.Windows.Forms.ToolStripMenuItem 'Open Lists Folder'
$menuExit = New-Object System.Windows.Forms.ToolStripMenuItem 'Exit'
$menuScan.Add_Click({ Start-ScanAndIndex })
$menuShow.Add_Click({ Show-Progress })
$menuLists.Add_Click({ Open-ListsFolder })
$menuExit.Add_Click({ Exit-Tray })

$contextMenu = New-Object System.Windows.Forms.ContextMenuStrip
[void]$contextMenu.Items.Add($menuScan)
[void]$contextMenu.Items.Add($menuShow)
[void]$contextMenu.Items.Add($menuLists)
[void]$contextMenu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
[void]$contextMenu.Items.Add($menuExit)

$notifyIcon = New-Object System.Windows.Forms.NotifyIcon
$notifyIcon.Text = 'screenshot-memory'
$notifyIcon.Icon = [System.Drawing.SystemIcons]::Application
$notifyIcon.ContextMenuStrip = $contextMenu
$notifyIcon.Visible = $true
$notifyIcon.Add_DoubleClick({ Start-ScanAndIndex })

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 1500
$timer.Add_Tick({
    $wasRunning = $menuScan.Enabled -eq $false
    $running = Test-JobRunning
    Update-MenuState
    if ($wasRunning -and -not $running) {
        $code = $script:LastExitCode
        if ($null -eq $code -and $null -ne $script:JobLogPath -and (Test-Path $script:JobLogPath)) {
            $tail = Get-Content -Path $script:JobLogPath -Tail 30 -ErrorAction SilentlyContinue
            if ($tail -match 'failed with exit code') {
                $code = 1
            } elseif ($tail -match 'Done\. You can close this window\.') {
                $code = 0
            }
        }
        if ($code -eq 0) {
            Show-Balloon -Title $script:AppName -Text 'Scan and Index finished successfully.' -Icon Info
        } elseif ($null -ne $code) {
            Show-Balloon -Title $script:AppName -Text 'Scan and Index failed. Use Show Progress for details.' -Icon Error
        } else {
            Show-Balloon -Title $script:AppName -Text 'Scan and Index console closed.' -Icon Info
        }
    }
})
$timer.Start()

Show-Balloon -Title $script:AppName -Text 'Tray ready. Right-click for Scan and Index.' -Icon Info
Update-MenuState
[System.Windows.Forms.Application]::Run()
