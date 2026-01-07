# Run this script as Administrator from the repository root.
# It will copy the project to C:\VantaBot, create a test-service, and install it with NSSM.
# Review before running. This script does NOT set your Discord token.

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $MyInvocation.MyCommand.Definition
$dest = 'C:\VantaBot'

Write-Host "Creating destination: $dest"
New-Item -ItemType Directory -Path $dest -Force | Out-Null

Write-Host "Copying project files to $dest (excluding node_modules and .git)"
if (Get-Command robocopy -ErrorAction SilentlyContinue) {
  $exclude = 'node_modules','.git'
  robocopy $repo $dest /E /XD $exclude | Out-Null
} else {
  # Fallback: Copy-Item (slower)
  Get-ChildItem -Path $repo -Force | Where-Object { $_.Name -notin @('node_modules','.git') } | ForEach-Object {
    $target = Join-Path $dest $_.Name
    if ($_.PSIsContainer) { Copy-Item -Path $_.FullName -Destination $target -Recurse -Force } else { Copy-Item -Path $_.FullName -Destination $target -Force }
  }
}

# Ensure logs directory
New-Item -ItemType Directory -Path (Join-Path $dest 'logs') -Force | Out-Null

# Ensure test-service.js exists (will overwrite if present)
$testFile = Join-Path $dest 'test-service.js'
@'
const fs = require('fs');
const path = 'C:\\VantaBot\\service-test.log';
try {
  fs.appendFileSync(path, `Started: ${new Date().toISOString()}\\nENV: ${JSON.stringify(process.env || {})}\\n\\n`);
} catch (e) {
  try { fs.appendFileSync('service-test.log', `Started(local): ${new Date().toISOString()}\\n${e.message}\\n\\n`); } catch {};
}
setInterval(()=>{
  try {
    fs.appendFileSync(path, `Alive: ${new Date().toISOString()}\\n`);
  } catch (e) {
    try { fs.appendFileSync('service-test.log', `Alive(local): ${new Date().toISOString()} ${e.message}\\n`); } catch {};
  }
}, 60000);
'@ | Set-Content -LiteralPath $testFile -Encoding UTF8

# Find node executable
$nodePath = (where.exe node | Select-Object -First 1)
if (-not $nodePath) { Write-Error 'node executable not found in PATH. Install Node.js and ensure it is on PATH.'; exit 1 }
$nodePath = $nodePath.Trim()
Write-Host "Using node: $nodePath"

# Check nssm availability
if (-not (Get-Command nssm -ErrorAction SilentlyContinue)) { Write-Error 'nssm not found. Install NSSM (e.g., via Chocolatey: choco install nssm) and run this script again as Admin.'; exit 1 }

# Remove old service if exists
try { nssm remove VantaBot confirm } catch {}

Write-Host 'Installing NSSM service VantaBot pointing to test-service.js'
nssm install VantaBot $nodePath (Join-Path $dest 'test-service.js')

nssm set VantaBot AppDirectory $dest
nssm set VantaBot AppStdout (Join-Path $dest 'logs\out.log')
nssm set VantaBot AppStderr (Join-Path $dest 'logs\err.log')

nssm set VantaBot AppRotateFiles 1

Write-Host 'Starting service...'
try { nssm start VantaBot } catch { Write-Host 'Service failed to start; check logs and Event Viewer.' }

Write-Host 'Done. Check C:\VantaBot\service-test.log and C:\VantaBot\logs for output.'
