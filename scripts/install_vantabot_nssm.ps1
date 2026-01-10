# Run this script as Administrator.
# It will copy this repo to C:\VantaBot, install dependencies, and install/replace the NSSM service `VantaBot`.
# It will prompt you for the Discord token (hidden input). Do NOT store the token in this script.

$ErrorActionPreference = 'Stop'

# Check admin
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Error "Please run this script as Administrator"
  exit 1
}

$serviceName = 'VantaBot'
$dest = 'C:\VantaBot'
$repo = Split-Path -Parent $MyInvocation.MyCommand.Definition
$repo = Split-Path -Parent $repo  # scripts/.. -> repo root

# Ensure destination exists
New-Item -ItemType Directory -Path $dest -Force | Out-Null

Write-Host "Copying project files to $dest (excluding node_modules and .git)..."
if (Get-Command robocopy -ErrorAction SilentlyContinue) {
  $exclude = 'node_modules','.git'
  robocopy $repo $dest /E /XD $exclude | Out-Null
} else {
  Get-ChildItem -Path $repo -Force | Where-Object { $_.Name -notin @('node_modules','.git') } | ForEach-Object {
    $target = Join-Path $dest $_.Name
    if ($_.PSIsContainer) { Copy-Item -Path $_.FullName -Destination $target -Recurse -Force } else { Copy-Item -Path $_.FullName -Destination $target -Force }
  }
}

# Check nssm
if (-not (Get-Command nssm -ErrorAction SilentlyContinue)) {
  Write-Error "nssm not found. Install NSSM first (e.g. choco install nssm) and re-run this script."
  exit 1
}

# Find node executable
$node = (where.exe node | Select-Object -First 1)
if (-not $node) {
  Write-Error "node.exe not found in PATH. Install Node.js and ensure 'node' is on PATH."
  exit 1
}
$node = $node.Trim()
Write-Host "Using node: $node"

# Find npm
$npm = (where.exe npm | Select-Object -First 1)
if (-not $npm) {
  Write-Error "npm not found in PATH. Reinstall Node.js (includes npm) and re-run this script."
  exit 1
}
$npm = $npm.Trim()
Write-Host "Using npm: $npm"

# Remove old service if present
try { nssm stop $serviceName -ErrorAction SilentlyContinue } catch {}
try { nssm remove $serviceName confirm -ErrorAction SilentlyContinue } catch {}

# Install dependencies in destination
Write-Host "Installing dependencies in $dest..."
Push-Location -LiteralPath $dest
try {
  & $npm install --omit=dev
  if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE" }
} finally {
  Pop-Location
}

# Install service pointing to index.js under C:\VantaBot
$indexPath = Join-Path $dest 'index.js'
if (-not (Test-Path $indexPath)) {
  Write-Host "index.js not found at $indexPath. Make sure you copied your bot files to C:\VantaBot."
  $resp = Read-Host "Do you want to continue and open C:\VantaBot in Explorer to copy files now? (y/n)"
  if ($resp -ne 'y') { Write-Host 'Aborting.'; exit 1 }
  explorer.exe C:\VantaBot
  Write-Host 'After copying files, run this script again.'; exit 0
}

Write-Host "Installing service $serviceName -> $node $indexPath"
nssm install $serviceName $node $indexPath
nssm set $serviceName AppDirectory $dest
nssm set $serviceName Start SERVICE_AUTO_START

# Restart on crash
nssm set $serviceName AppExit Default Restart
nssm set $serviceName AppRestartDelay 5000

# Setup logs
New-Item -ItemType Directory -Path (Join-Path $dest 'logs') -Force | Out-Null
nssm set $serviceName AppStdout (Join-Path $dest 'logs\out.log')
nssm set $serviceName AppStderr (Join-Path $dest 'logs\err.log')
nssm set $serviceName AppRotateFiles 1
nssm set $serviceName AppRotateOnline 1
nssm set $serviceName AppRotateSeconds 86400

# Prompt for token securely
$secure = Read-Host "Enter DISCORD_TOKEN (input hidden)" -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
$plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)

$plain = ($plain | ForEach-Object { $_.Trim() })
if (-not $plain -or $plain.Length -lt 40) {
  Write-Error "DISCORD_TOKEN looks too short/empty. Aborting."
  exit 1
}

# Write token.txt as a robust fallback (no newline, no BOM)
try {
  $tokenPath = Join-Path $dest 'token.txt'
  Set-Content -LiteralPath $tokenPath -Value $plain -NoNewline -Encoding ascii
  Write-Host "Wrote token fallback to $tokenPath"
} catch {
  Write-Host "Warning: could not write token.txt fallback: $_"
}

# Set environment variables for service
# Note: AppEnvironmentExtra supports multiple entries separated by newlines.
$envBlock = "DISCORD_TOKEN=$plain`nNODE_ENV=production"
nssm set $serviceName AppEnvironmentExtra $envBlock
Write-Host 'Environment variables set for service (DISCORD_TOKEN, NODE_ENV).'

# Start service
try {
  nssm start $serviceName
  Start-Sleep -Seconds 2
  Write-Host "Service start attempted. Check logs at C:\VantaBot\logs\out.log and err.log"
} catch {
  Write-Host "Service start failed: $_"
}

Write-Host 'Done.'
