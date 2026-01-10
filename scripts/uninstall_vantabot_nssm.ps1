# Run this script as Administrator. It will stop and remove the NSSM service `VantaBot`.

$ErrorActionPreference = 'Stop'

# Check admin
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Error "Please run this script as Administrator"
  exit 1
}

$serviceName = 'VantaBot'

# Check nssm
if (-not (Get-Command nssm -ErrorAction SilentlyContinue)) {
  Write-Error "nssm not found. Install NSSM first (e.g. choco install nssm) and re-run this script."
  exit 1
}

try { nssm stop $serviceName -ErrorAction SilentlyContinue } catch {}
try { nssm remove $serviceName confirm -ErrorAction SilentlyContinue } catch {}

Write-Host "Service $serviceName removed (if it existed)."