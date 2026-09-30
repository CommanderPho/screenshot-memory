# screenshot-memory Windows setup script
# This script sets up everything needed to run screenshot-memory on Windows

[CmdletBinding(DefaultParameterSetName = 'Install')]
param(
    [Parameter(ParameterSetName = 'Uninstall')]
    [Alias('r')]
    [switch]$Remove,

    [Parameter(ParameterSetName = 'Uninstall')]
    [switch]$Uninstall,

    [Parameter(ParameterSetName = 'Install')]
    [Alias('y')]
    [switch]$Yes,

    [Parameter(ParameterSetName = 'Install')]
    [switch]$SkipModelDownload
)

$ErrorActionPreference = 'Stop'

# Detect raw arguments (for unix-style flags like --remove, --uninstall, -r, --yes, -y)
if ($args) {
    foreach ($arg in $args) {
        if ($arg -in @('--remove', '--uninstall', '-r')) {
            $Uninstall = $true
        }
        if ($arg -in @('--yes', '-y')) {
            $Yes = $true
        }
    }
}

# ============================================
# Colors & Formatting
# ============================================
$ESC = [char]27
$CYAN = "$ESC[0;36m"
$WHITE = "$ESC[1;37m"
$BLUE = "$ESC[0;34m"
$GREEN = "$ESC[0;32m"
$YELLOW = "$ESC[1;33m"
$RED = "$ESC[0;31m"
$NC = "$ESC[0m"

function print_header([string]$title) {
    Write-Host ""
    Write-Host "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    Write-Host "${WHITE}  $title${NC}"
    Write-Host "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    Write-Host ""
}

function print_step([string]$message) {
    Write-Host "${BLUE}▶${NC} $message"
}

function print_success([string]$message) {
    Write-Host "${GREEN}✓${NC} $message"
}

function print_warning([string]$message) {
    Write-Host "${YELLOW}⚠${NC} $message"
}

function print_error([string]$message) {
    Write-Host "${RED}✗${NC} $message"
}

function print_info([string]$message) {
    Write-Host "${CYAN}ℹ${NC} $message"
}

function command_exists([string]$cmd) {
    $found = Get-Command $cmd -ErrorAction SilentlyContinue
    return ($null -ne $found)
}

function Add-PathIfMissing([string]$directory) {
    if (-not (Test-Path $directory)) {
        return
    }

    # Add to current session PATH
    $currentPaths = $env:Path -split ';'
    if ($currentPaths -notcontains $directory) {
        $env:Path = "$directory;$env:Path"
    }

    # Add to persistent User PATH
    try {
        $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
        if ($null -eq $userPath) { $userPath = "" }
        $userPaths = $userPath -split ';' | Where-Object { $_ -ne "" }
        if ($userPaths -notcontains $directory) {
            $newPath = ($userPaths + $directory) -join ';'
            [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
        }
    } catch {
        # Non-fatal if user environment registry cannot be written
    }
}

# ============================================
# Uninstall mode
# ============================================
if ($Remove -or $Uninstall) {
    Write-Host ""
    Write-Host "Uninstalling screenshot-memory..."
    Write-Host ""

    $shimLocations = @(
        "$env:USERPROFILE\.bun\bin",
        "$env:USERPROFILE\.local\bin",
        "$env:USERPROFILE\bin"
    )

    $shimNames = @(
        "ssm", "ssm.cmd", "ssm.ps1",
        "screenshot-memory", "screenshot-memory.cmd", "screenshot-memory.ps1"
    )

    foreach ($loc in $shimLocations) {
        if (Test-Path $loc) {
            foreach ($name in $shimNames) {
                $filePath = Join-Path $loc $name
                if (Test-Path $filePath) {
                    try {
                        Remove-Item -Path $filePath -Force -ErrorAction SilentlyContinue
                        print_success "Removed $filePath"
                    } catch {
                        print_warning "Failed to remove $filePath"
                    }
                }
            }
        }
    }

    # Remove Windows data, cache and config directories
    $dataDirs = @(
        (Join-Path $env:APPDATA "screenshot-memory"),
        (Join-Path $env:APPDATA "screenshot-memory-nodejs"),
        (Join-Path $env:LOCALAPPDATA "screenshot-memory"),
        (Join-Path $env:USERPROFILE ".config\screenshot-memory")
    )

    foreach ($dir in $dataDirs) {
        if (Test-Path $dir) {
            try {
                Remove-Item -Path $dir -Recurse -Force -ErrorAction SilentlyContinue
                print_success "Removed $dir"
            } catch {
                print_warning "Failed to remove $dir"
            }
        }
    }

    Write-Host ""
    Write-Host "Done! screenshot-memory has been uninstalled."
    Write-Host "Note: Ollama and its models were not removed."
    Write-Host ""
    exit 0
}

# ============================================
# Main Installation
# ============================================
print_header "📸 screenshot-memory Setup"

Write-Host "${WHITE}This script will set up screenshot-memory on your Windows system.${NC}"
Write-Host ""
Write-Host "It will:"
Write-Host "  • Check/install Bun (fast JavaScript runtime)"
Write-Host "  • Check/install Ollama (local AI for image captioning)"
Write-Host "  • Download the llava-phi3 vision model (~2.9GB)"
Write-Host "  • Download the nomic-embed-text embedding model"
Write-Host "  • Install dependencies and build the project"
Write-Host "  • Create the 'ssm' command globally"
Write-Host ""

# Confirmation prompt unless -Yes is specified
if (-not $Yes) {
    $confirmation = Read-Host "Continue? (Y/n)"
    if ($confirmation -match '^[Nn]$') {
        Write-Host "Setup cancelled."
        exit 0
    }
}

# ============================================
# Step 1: Check/Install Bun
# ============================================
print_header "Step 1: JavaScript Runtime"

$bunDir = Join-Path $env:USERPROFILE ".bun\bin"
if (Test-Path (Join-Path $bunDir "bun.exe")) {
    Add-PathIfMissing $bunDir
}

if (command_exists "bun") {
    $bunVersion = (& bun --version 2>$null)
    print_success "Bun is installed (v$bunVersion)"
} else {
    print_step "Installing Bun..."

    try {
        Invoke-Expression (Invoke-RestMethod -Uri "https://bun.sh/install.ps1")
    } catch {
        if (command_exists "winget") {
            print_info "Attempting install via winget..."
            winget install Oven-sh.Bun --accept-source-agreements --accept-package-agreements
        } elseif (command_exists "scoop") {
            print_info "Attempting install via scoop..."
            scoop install bun
        }
    }

    if (Test-Path (Join-Path $bunDir "bun.exe")) {
        Add-PathIfMissing $bunDir
    }

    if (command_exists "bun") {
        print_success "Bun installed successfully"
    } else {
        print_error "Failed to install Bun automatically. Please install Bun manually: https://bun.sh"
        exit 1
    }
}

# ============================================
# Step 2: Check/Install Ollama
# ============================================
print_header "Step 2: Ollama (AI Vision)"

$ollamaStandardDirs = @(
    (Join-Path $env:LOCALAPPDATA "Programs\Ollama"),
    "C:\Program Files\Ollama"
)
foreach ($dir in $ollamaStandardDirs) {
    if (Test-Path (Join-Path $dir "ollama.exe")) {
        Add-PathIfMissing $dir
    }
}

if (command_exists "ollama") {
    print_success "Ollama is installed"
} else {
    print_step "Installing Ollama..."

    $installed = $false
    if (command_exists "winget") {
        print_info "Installing Ollama via winget..."
        try {
            winget install Ollama.Ollama --accept-source-agreements --accept-package-agreements
            $installed = $true
        } catch {
            print_warning "winget installation failed, falling back to installer download..."
        }
    }

    if (-not $installed) {
        print_info "Downloading Ollama installer..."
        $installerPath = Join-Path $env:TEMP "OllamaSetup.exe"
        Invoke-WebRequest -Uri "https://ollama.com/download/OllamaSetup.exe" -OutFile $installerPath
        print_info "Running Ollama installer..."
        Start-Process -FilePath $installerPath -ArgumentList "/silent" -Wait
    }

    foreach ($dir in $ollamaStandardDirs) {
        if (Test-Path (Join-Path $dir "ollama.exe")) {
            Add-PathIfMissing $dir
        }
    }

    if (command_exists "ollama") {
        print_success "Ollama installed successfully"
    } else {
        print_error "Failed to install Ollama. Please install Ollama manually: https://ollama.com"
        exit 1
    }
}

# ============================================
# Step 3: Start Ollama & Download Models
# ============================================
print_header "Step 3: Vision & Embedding Models"

$ollamaRunning = $false

function Test-OllamaApi {
    try {
        $resp = Invoke-RestMethod -Uri "http://localhost:11434/api/tags" -Method Get -TimeoutSec 2 -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

if (Test-OllamaApi) {
    $ollamaRunning = $true
    print_success "Ollama is running"
} else {
    print_step "Starting Ollama..."

    $ollamaApp = Join-Path $env:LOCALAPPDATA "Programs\Ollama\ollama app.exe"
    if (Test-Path $ollamaApp) {
        Start-Process -FilePath $ollamaApp
    } else {
        Start-Process -FilePath "ollama" -ArgumentList "serve" -WindowStyle Hidden
    }

    print_info "Waiting for Ollama to start..."
    for ($i = 1; $i -le 30; $i++) {
        if (Test-OllamaApi) {
            $ollamaRunning = $true
            break
        }
        Start-Sleep -Seconds 1
    }

    if ($ollamaRunning) {
        print_success "Ollama started"
    } else {
        print_warning "Could not start Ollama automatically."
        print_info "Please start Ollama manually and re-run this script."
    }
}

if ($ollamaRunning -and (-not $SkipModelDownload)) {
    print_step "Checking for vision model..."

    $models = @()
    try {
        $tags = Invoke-RestMethod -Uri "http://localhost:11434/api/tags" -Method Get -TimeoutSec 5 -ErrorAction Stop
        if ($tags.models) {
            $models = $tags.models | ForEach-Object { $_.name }
        }
    } catch {
        $models = @()
    }

    # Check Vision Model
    $hasVisionModel = $false
    $targetVisionModels = @("llava-phi3", "llava-phi3:latest", "llava:7b", "smolvlm2")
    foreach ($vModel in $targetVisionModels) {
        if ($models -contains $vModel -or ($models -like "$vModel*").Count -gt 0) {
            $hasVisionModel = $true
            print_success "Vision model found: $vModel"
            break
        }
    }

    if (-not $hasVisionModel) {
        print_step "Downloading llava-phi3 vision model (~2.9GB)..."
        print_info "This may take a few minutes depending on your internet speed."
        Write-Host ""

        & ollama pull llava-phi3
        if ($LASTEXITCODE -eq 0) {
            print_success "Vision model downloaded"
        } else {
            print_warning "Failed to download vision model."
            print_info "You can download it later with: ollama pull llava-phi3"
        }
    }

    # Check Embedding Model
    print_step "Checking for embedding model..."
    $hasEmbedModel = $false
    $targetEmbedModels = @("nomic-embed-text", "nomic-embed-text:latest")
    foreach ($eModel in $targetEmbedModels) {
        if ($models -contains $eModel -or ($models -like "$eModel*").Count -gt 0) {
            $hasEmbedModel = $true
            print_success "Embedding model found: $eModel"
            break
        }
    }

    if (-not $hasEmbedModel) {
        print_step "Downloading nomic-embed-text embedding model..."
        print_info "Used only when memvid's local ONNX model is unavailable. No API key."
        Write-Host ""

        & ollama pull nomic-embed-text
        if ($LASTEXITCODE -eq 0) {
            print_success "Embedding model downloaded"
        } else {
            print_warning "Failed to download embedding model."
            print_info "You can download it later with: ollama pull nomic-embed-text"
        }
    }
} elseif (-not $ollamaRunning) {
    print_warning "Skipping model download (Ollama not running)"
    print_info "After starting Ollama, run: ollama pull llava-phi3; ollama pull nomic-embed-text"
}

# ============================================
# Step 4: Install Dependencies
# ============================================
print_header "Step 4: Project Dependencies"

print_step "Installing dependencies..."
Set-Location -Path $PSScriptRoot
& bun install

if ($LASTEXITCODE -eq 0) {
    print_success "Dependencies installed"
} else {
    print_error "Failed to install dependencies"
    exit 1
}

# ============================================
# Step 5: Build Project
# ============================================
print_header "Step 5: Building"

print_step "Building project..."
& bun run build

if ($LASTEXITCODE -eq 0) {
    print_success "Build complete"
} else {
    print_error "Build failed"
    exit 1
}

# ============================================
# Step 6: Create Global Command
# ============================================
print_header "Step 6: Global Command"

print_step "Creating 'ssm' command..."

# Prefer ~/.bun/bin, fallback to ~/.local/bin or ~/bin
$targetBinDir = $bunDir
if (-not (Test-Path $targetBinDir)) {
    $targetBinDir = Join-Path $env:USERPROFILE ".local\bin"
    if (-not (Test-Path $targetBinDir)) {
        New-Item -ItemType Directory -Path $targetBinDir -Force | Out-Null
    }
}

$cliPath = Join-Path $PSScriptRoot "dist\cli.js"

# 1. Create cmd wrapper (for cmd.exe, PowerShell, and generic shells)
$cmdContent = "@echo off`r`nbun `"$cliPath`" %*`r`n"
Set-Content -Path (Join-Path $targetBinDir "ssm.cmd") -Value $cmdContent -NoNewline -Encoding ASCII
Set-Content -Path (Join-Path $targetBinDir "screenshot-memory.cmd") -Value $cmdContent -NoNewline -Encoding ASCII

# 2. Create ps1 wrapper (for native PowerShell)
$ps1Content = "& bun `"$cliPath`" @args`r`n"
Set-Content -Path (Join-Path $targetBinDir "ssm.ps1") -Value $ps1Content -NoNewline -Encoding UTF8
Set-Content -Path (Join-Path $targetBinDir "screenshot-memory.ps1") -Value $ps1Content -NoNewline -Encoding UTF8

# 3. Create bash wrapper / symlink for Git Bash / MSYS2 / WSL if present
$posixCliPath = $cliPath.Replace('\', '/')
$bashContent = "#!/bin/sh`nexec bun `"$posixCliPath`" `"`$@`"`n"
try {
    $bashScriptPath = Join-Path $targetBinDir "ssm"
    Set-Content -Path $bashScriptPath -Value $bashContent -NoNewline -Encoding ASCII
} catch {
    # Non-fatal
}

# Ensure target bin directory is in PATH
Add-PathIfMissing $targetBinDir

print_success "Created 'ssm' command at $targetBinDir\ssm.cmd"
print_success "Created 'ssm' command at $targetBinDir\ssm.ps1"

# ============================================
# Done!
# ============================================
print_header "Setup Complete!"

Write-Host "${GREEN}screenshot-memory is ready to use!${NC}"
Write-Host ""
Write-Host "${WHITE}Quick Start:${NC}"
Write-Host ""
$sampleScreenshotDir = Join-Path $env:USERPROFILE "Pictures\Screenshots"
Write-Host "  ${CYAN}1.${NC} Index your screenshots:"
Write-Host "     ${WHITE}ssm index `"$sampleScreenshotDir`"${NC}"
Write-Host ""
Write-Host "  ${CYAN}2.${NC} Search for anything:"
Write-Host "     ${WHITE}ssm find `"error message`"${NC}"
Write-Host "     ${WHITE}ssm find `"red car`"${NC}"
Write-Host ""
Write-Host "  ${CYAN}3.${NC} Auto-index new screenshots:"
Write-Host "     ${WHITE}ssm watch${NC}"
Write-Host ""
Write-Host "${CYAN}Documentation:${NC} https://github.com/memvid/screenshot-memory"
Write-Host ""
