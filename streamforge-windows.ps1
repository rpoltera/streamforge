# StreamForge Windows Installer
# Run as Administrator in PowerShell:
# Set-ExecutionPolicy Bypass -Scope Process -Force
# .\streamforge-windows.ps1

$ErrorActionPreference = "Stop"
$REPO = "https://raw.githubusercontent.com/rpoltera/streamforge/main"
$INSTALL_DIR = "C:\StreamForge"
$DATA_DIR = "C:\StreamForge\data"
$NODE_VERSION = "20.19.0"
$FFMPEG_VERSION = "7.1"
$SERVICE_NAME = "StreamForge"

function Write-Banner {
    Clear-Host
    Write-Host @"
   _____ __                           ______
  / ___// /_________  ____ _____ ___ / ____/___  _________ ____
  \__ \/ __/ ___/ _ \/ __ ``/ __ ``__ \/ /_  / _ \/ ___/ __ ``/ _ \
 ___/ / /_/ /  /  __/ /_/ / / / / / / __/ /  __/ /  / /_/ /  __/
/____/\__/_/   \___/\__,_/_/ /_/ /_/_/    \___/_/   \__, /\___/
                                                    /____/
"@ -ForegroundColor Cyan
    Write-Host "  IPTV Playout Manager -- Windows Installer" -ForegroundColor Yellow
    Write-Host ""
}

function Write-Step($msg) { Write-Host "  [*] $msg" -ForegroundColor Yellow }
function Write-OK($msg)   { Write-Host "  [+] $msg" -ForegroundColor Green }
function Write-Err($msg)  { Write-Host "  [!] $msg" -ForegroundColor Red; exit 1 }

# Check admin
if (-NOT ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]"Administrator")) {
    Write-Err "Run this script as Administrator"
}

Write-Banner

# ── Install Node.js ──────────────────────────────────────────────────────────
Write-Step "Checking Node.js..."
$nodeInstalled = $false
try { $v = node --version 2>$null; if ($v -match "v20") { $nodeInstalled = $true } } catch {}

if (-not $nodeInstalled) {
    Write-Step "Downloading Node.js $NODE_VERSION..."
    $nodeMsi = "$env:TEMP\node-v$NODE_VERSION-x64.msi"
    Invoke-WebRequest "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-x64.msi" -OutFile $nodeMsi
    Write-Step "Installing Node.js..."
    Start-Process msiexec -ArgumentList "/i `"$nodeMsi`" /quiet /norestart" -Wait
    $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH","Machine")
    Write-OK "Node.js installed"
} else {
    Write-OK "Node.js already installed ($v)"
}

# ── Install FFmpeg ──────────────────────────────────────────────────────────
Write-Step "Checking FFmpeg..."
$ffmpegInstalled = $false
try { $fv = ffmpeg -version 2>$null | Select-String "ffmpeg version"; if ($fv) { $ffmpegInstalled = $true } } catch {}

if (-not $ffmpegInstalled) {
    Write-Step "Downloading FFmpeg..."
    $ffmpegZip = "$env:TEMP\ffmpeg.zip"
    Invoke-WebRequest "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip" -OutFile $ffmpegZip
    Write-Step "Extracting FFmpeg..."
    Expand-Archive $ffmpegZip "$env:TEMP\ffmpeg-extract" -Force
    $ffmpegDir = Get-ChildItem "$env:TEMP\ffmpeg-extract" -Directory | Select-Object -First 1
    New-Item -ItemType Directory -Path "C:\ffmpeg\bin" -Force | Out-Null
    Copy-Item "$($ffmpegDir.FullName)\bin\ffmpeg.exe" "C:\ffmpeg\bin\" -Force
    Copy-Item "$($ffmpegDir.FullName)\bin\ffprobe.exe" "C:\ffmpeg\bin\" -Force
    # Add to PATH
    $currentPath = [System.Environment]::GetEnvironmentVariable("PATH","Machine")
    if ($currentPath -notlike "*C:\ffmpeg\bin*") {
        [System.Environment]::SetEnvironmentVariable("PATH","$currentPath;C:\ffmpeg\bin","Machine")
    }
    $env:PATH = "$env:PATH;C:\ffmpeg\bin"
    Write-OK "FFmpeg installed"
} else {
    Write-OK "FFmpeg already installed"
}

# ── Create directories ───────────────────────────────────────────────────────
Write-Step "Creating StreamForge directories..."
@($INSTALL_DIR, "$INSTALL_DIR\server", "$INSTALL_DIR\public\css", "$INSTALL_DIR\public\js",
  "$DATA_DIR\config", "$DATA_DIR\hls", "$DATA_DIR\uploads") | ForEach-Object {
    New-Item -ItemType Directory -Path $_ -Force | Out-Null
}
Write-OK "Directories created"

# ── Download app files ───────────────────────────────────────────────────────
Write-Step "Downloading StreamForge..."
$files = @{
    "server/index.js"     = "$INSTALL_DIR\server\index.js"
    "server/package.json" = "$INSTALL_DIR\server\package.json"
    "public/index.html"   = "$INSTALL_DIR\public\index.html"
    "public/css/main.css" = "$INSTALL_DIR\public\css\main.css"
    "public/js/app.js"    = "$INSTALL_DIR\public\js\app.js"
}
foreach ($src in $files.Keys) {
    Invoke-WebRequest "$REPO/$src" -OutFile $files[$src]
}
Write-OK "Files downloaded"

# ── npm install ──────────────────────────────────────────────────────────────
Write-Step "Installing Node.js dependencies..."
Push-Location "$INSTALL_DIR\server"
& npm install --production --quiet
Pop-Location
Write-OK "Dependencies installed"

# ── Create config ────────────────────────────────────────────────────────────
$configFile = "$DATA_DIR\config\config.json"
if (-not (Test-Path $configFile)) {
    @{
        port = 8080
        baseUrl = "http://localhost:8080"
        dataDir = $DATA_DIR.Replace("\","\\")
        ffmpegPath = "C:\\ffmpeg\\bin\\ffmpeg.exe"
        ffprobePath = "C:\\ffmpeg\\bin\\ffprobe.exe"
    } | ConvertTo-Json | Set-Content $configFile
}

# ── Install as Windows Service using NSSM ───────────────────────────────────
Write-Step "Installing Windows Service..."

# Download NSSM if not present
$nssm = "$INSTALL_DIR\nssm.exe"
if (-not (Test-Path $nssm)) {
    Invoke-WebRequest "https://nssm.cc/release/nssm-2.24.zip" -OutFile "$env:TEMP\nssm.zip"
    Expand-Archive "$env:TEMP\nssm.zip" "$env:TEMP\nssm-extract" -Force
    Copy-Item "$env:TEMP\nssm-extract\nssm-2.24\win64\nssm.exe" $nssm -Force
}

# Remove existing service if present
& $nssm stop $SERVICE_NAME 2>$null
& $nssm remove $SERVICE_NAME confirm 2>$null

$nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
& $nssm install $SERVICE_NAME $nodeExe "$INSTALL_DIR\server\index.js"
& $nssm set $SERVICE_NAME AppDirectory "$INSTALL_DIR\server"
& $nssm set $SERVICE_NAME DisplayName "StreamForge IPTV Playout Manager"
& $nssm set $SERVICE_NAME Description "StreamForge IPTV Playout Manager - http://localhost:8080"
& $nssm set $SERVICE_NAME AppEnvironmentExtra "SF_DATA=$DATA_DIR" "SF_CONFIG=$configFile"
& $nssm set $SERVICE_NAME Start SERVICE_AUTO_START
& $nssm set $SERVICE_NAME AppStdout "$DATA_DIR\streamforge.log"
& $nssm set $SERVICE_NAME AppStderr "$DATA_DIR\streamforge-error.log"

Write-OK "Service installed"

# ── Start service ────────────────────────────────────────────────────────────
Write-Step "Starting StreamForge..."
& $nssm start $SERVICE_NAME
Start-Sleep 3

# ── Add firewall rule ────────────────────────────────────────────────────────
Write-Step "Adding firewall rule..."
netsh advfirewall firewall delete rule name="StreamForge" 2>$null
netsh advfirewall firewall add rule name="StreamForge" dir=in action=allow protocol=TCP localport=8080 | Out-Null
Write-OK "Firewall rule added"

# ── Create desktop shortcut ──────────────────────────────────────────────────
$WScriptShell = New-Object -ComObject WScript.Shell
$shortcut = $WScriptShell.CreateShortcut("$env:PUBLIC\Desktop\StreamForge.lnk")
$shortcut.TargetPath = "http://localhost:8080"
$shortcut.Description = "StreamForge IPTV Manager"
$shortcut.Save()

# ── Create update script ─────────────────────────────────────────────────────
@"
# StreamForge Update Script - Run as Administrator
`$REPO = "https://raw.githubusercontent.com/rpoltera/streamforge/main"
`$INSTALL_DIR = "C:\StreamForge"
`$SERVICE_NAME = "StreamForge"
`$nssm = "`$INSTALL_DIR\nssm.exe"

Write-Host "Stopping StreamForge..." -ForegroundColor Yellow
& `$nssm stop `$SERVICE_NAME

`$files = @{
    "server/index.js"     = "`$INSTALL_DIR\server\index.js"
    "server/package.json" = "`$INSTALL_DIR\server\package.json"
    "public/index.html"   = "`$INSTALL_DIR\public\index.html"
    "public/css/main.css" = "`$INSTALL_DIR\public\css\main.css"
    "public/js/app.js"    = "`$INSTALL_DIR\public\js\app.js"
}
foreach (`$src in `$files.Keys) {
    Invoke-WebRequest "`$REPO/`$src" -OutFile `$files[`$src]
}

Push-Location "`$INSTALL_DIR\server"
npm install --production --quiet
Pop-Location

Write-Host "Starting StreamForge..." -ForegroundColor Yellow
& `$nssm start `$SERVICE_NAME
Write-Host "Done! StreamForge updated." -ForegroundColor Green
"@ | Set-Content "$INSTALL_DIR\streamforge-update.ps1"

Write-Host ""
Write-OK "StreamForge installed successfully!"
Write-Host ""
Write-Host "  Access it at: " -NoNewline; Write-Host "http://localhost:8080" -ForegroundColor Cyan
Write-Host "  Data folder:  " -NoNewline; Write-Host $DATA_DIR -ForegroundColor Cyan
Write-Host "  Update:       " -NoNewline; Write-Host "Run streamforge-update.ps1 as Administrator" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Opening StreamForge in your browser..." -ForegroundColor Yellow
Start-Sleep 2
Start-Process "http://localhost:8080"
