param(
  [string]$Remote = $env:GITHUB_REPO,
  [string]$Branch = $env:GIT_BRANCH,
  [string]$Message = "chore: update files",
  [string]$Token = $env:GIT_TOKEN
)

try {
  $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
  $repoRoot = Resolve-Path (Join-Path $scriptDir '..')
  Set-Location $repoRoot

  if (-not $Branch -or $Branch -eq "") { $Branch = "main" }

  if (-not (Test-Path ".git")) {
    Write-Host "Initializing git repository..."
    git init | Out-Null
  }

  if ($env:GIT_USER) { git config user.name $env:GIT_USER }
  if ($env:GIT_EMAIL) { git config user.email $env:GIT_EMAIL }

  Write-Host "Staging all changes..."
  git add -A

  $status = git status --porcelain
  if (-not $status) {
    Write-Host "No changes to commit."
  } else {
    Write-Host "Committing: $Message"
    git commit -m $Message
  }

  if ($Remote) {
    $existing = git remote get-url origin 2>$null
    $remoteUrl = $Remote
    if ($Token -and $Remote -match '^https://') {
      # embed token for push (be cautious with token exposure)
      $remoteUrl = $Remote -replace '^https://', "https://$Token@"
    }
    if (-not $existing) {
      git remote add origin $remoteUrl
    } else {
      git remote set-url origin $remoteUrl
    }
  } else {
    Write-Host "No remote provided. Set GITHUB_REPO env var or pass -Remote to push to GitHub."
  }

  if ($Remote) {
    Write-Host "Pushing to origin/$Branch..."
    git push -u origin $Branch
    if ($LASTEXITCODE -ne 0) { Write-Host "Push failed (exit $LASTEXITCODE). Check credentials/remote URL."; exit $LASTEXITCODE }
    Write-Host "Push successful."
  }

} catch {
  Write-Host "Error: $($_.Exception.Message)"
  exit 1
}
