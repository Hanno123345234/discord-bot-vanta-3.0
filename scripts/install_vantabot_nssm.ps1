# Run this script as Administrator. It will install/replace the NSSM service `VantaBot` for C:\VantaBot\index.js
# It will prompt you for the Discord token (hidden input). Do NOT store the token in this script.

$ErrorActionPreference = 'Stop'

# Check admin
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Error "Please run this script as Administrator"
  exit 1
}

$serviceName = 'VantaBot'
$dest = 'C:\VantaBot'

# Ensure destination exists
New-Item -ItemType Directory -Path $dest -Force | Out-Null

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

# Remove old service if present
try { nssm stop $serviceName -ErrorAction SilentlyContinue } catch {}
try { nssm remove $serviceName confirm -ErrorAction SilentlyContinue } catch {}

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

# Setup logs
New-Item -ItemType Directory -Path (Join-Path $dest 'logs') -Force | Out-Null
nssm set $serviceName AppStdout (Join-Path $dest 'logs\out.log')
nssm set $serviceName AppStderr (Join-Path $dest 'logs\err.log')
nssm set $serviceName AppRotateFiles 1

# Prompt for token securely
$secure = Read-Host "Enter DISCORD_TOKEN (input hidden)" -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
$plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)

# Set environment variable for service
nssm set $serviceName AppEnvironmentExtra "DISCORD_TOKEN=$plain"
Write-Host 'Environment variable set for service (DISCORD_TOKEN).'

# Start service
try {
  nssm start $serviceName
  Start-Sleep -Seconds 2
  Write-Host "Service start attempted. Check logs at C:\VantaBot\logs\out.log and err.log"
} catch {
  Write-Host "Service start failed: $_"
}

Write-Host 'Done.'
