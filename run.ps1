<#
.SYNOPSIS
  One-shot setup for the patched Codex (Chrome plugin enabled).

.DESCRIPTION
  Copies the newest installed Codex package out of the protected WindowsApps
  store folder into a fixed, writable location, patches it so the bundled Chrome
  plugin is available, (re)creates a Desktop shortcut, and launches it.

  Re-run this after every Codex Store update: it rebuilds the patched copy from
  the latest installed version. That's the whole update flow — nothing else to do.

.PARAMETER NoLaunch
  Patch and set up the shortcut, but do not start Codex afterward.

.PARAMETER NoShortcut
  Skip creating/refreshing the Desktop shortcut.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\run.ps1
#>
param(
  [switch]$NoLaunch,
  [switch]$NoShortcut
)

$ErrorActionPreference = "Stop"

# --- Fixed config (intentionally not a choice) ---------------------------------
$Target       = Join-Path $HOME "codex-patched"   # patched copy lives here
$MinNodeMajor = 18
$RepoRoot     = $PSScriptRoot
$Patcher      = Join-Path $RepoRoot "scripts\patch-codex-chrome-windows.mjs"
$Launcher     = Join-Path $RepoRoot "scripts\launch-patched-codex.ps1"
$WindowsApps  = "C:\Program Files\WindowsApps"
$ShortcutName = "Codex (Patched).lnk"

function Write-Step([string]$msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok([string]$msg)   { Write-Host "    $msg" -ForegroundColor Green }
function Fail([string]$msg)       { Write-Host "`nERROR: $msg" -ForegroundColor Red; exit 1 }

# Long-path-safe recursive delete. Remove-Item -Recurse chokes on the deep
# node_modules paths (> 260 chars) inside extracted asar trees in PS 5.1;
# mirroring an empty dir over the target with robocopy empties it safely, then
# the now-empty root deletes cleanly.
function Remove-Tree([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { return }
  $empty = Join-Path $env:TEMP "codex-empty-mirror"
  New-Item -ItemType Directory -Path $empty -Force | Out-Null
  & robocopy "$empty" "$path" /MIR /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
  Remove-Item -LiteralPath $path  -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $empty -Recurse -Force -ErrorAction SilentlyContinue
  $global:LASTEXITCODE = 0
}

# --- 1. Node.js present and recent enough --------------------------------------
Write-Step "Checking Node.js"
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Fail "Node.js is not installed or not on PATH. Install it from https://nodejs.org (LTS) and re-run."
}
$nodeVersion = (& node --version).Trim()            # e.g. v24.10.0
$nodeMajor = [int](($nodeVersion -replace '^v','').Split('.')[0])
if ($nodeMajor -lt $MinNodeMajor) {
  Fail "Node.js $nodeVersion is too old (need >= $MinNodeMajor). Update from https://nodejs.org and re-run."
}
Write-Ok "Node.js $nodeVersion ($($node.Source))"

# --- 2. Install repo dependencies (@electron/asar) -----------------------------
Write-Step "Installing dependencies"
Push-Location $RepoRoot
try {
  $pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
  if ($pnpm) {
    & pnpm install
    if ($LASTEXITCODE -ne 0) { Fail "pnpm install failed (exit $LASTEXITCODE)." }
    Write-Ok "Dependencies installed with pnpm"
  } else {
    Write-Host "    pnpm not found, falling back to npm install" -ForegroundColor Yellow
    & npm install
    if ($LASTEXITCODE -ne 0) { Fail "npm install failed (exit $LASTEXITCODE)." }
    Write-Ok "Dependencies installed with npm"
  }
} finally {
  Pop-Location
}

# --- 3. Locate newest installed Codex package ----------------------------------
Write-Step "Locating installed Codex package"
$sourcePath = $null
# Preferred: ask the package manager. This works without the special directory-
# listing permission that WindowsApps normally denies.
try {
  $pkg = Get-AppxPackage -Name "OpenAI.Codex*" -ErrorAction Stop |
    Sort-Object -Property Version -Descending |
    Select-Object -First 1
  if ($pkg) { $sourcePath = $pkg.InstallLocation }
} catch { }
# Fallback: scan WindowsApps directly (needs listing permission).
if (-not $sourcePath) {
  $dir = Get-ChildItem -LiteralPath $WindowsApps -Directory -Filter "OpenAI.Codex_*" -ErrorAction SilentlyContinue |
    Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName "app\resources\app.asar") } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if ($dir) { $sourcePath = $dir.FullName }
}
if (-not $sourcePath -or -not (Test-Path -LiteralPath (Join-Path $sourcePath "app\resources\app.asar"))) {
  Fail "No installed Codex package found. Install Codex from the Microsoft Store first."
}
Write-Ok "Source: $sourcePath"

# --- 4. Stop any running Codex (store or patched) so files unlock --------------
Write-Step "Stopping any running Codex processes"
Get-Process -Name "Codex" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 500
Write-Ok "Done"

# --- 5. Rebuild the patched copy at the fixed location -------------------------
Write-Step "Copying Codex to $Target"
if (Test-Path -LiteralPath $Target) {
  # Kill anything still running from the target (helpers can outlive Codex.exe).
  Get-CimInstance Win32_Process |
    Where-Object { $_.ExecutablePath -and $_.ExecutablePath -like "$Target*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 300
  Remove-Tree $Target
  if (Test-Path -LiteralPath $Target) {
    Fail "Could not remove existing $Target. Close Codex (and any patched Codex helpers) and re-run."
  }
}
# robocopy handles the deep node_modules paths that trip Copy-Item's MAX_PATH.
& robocopy "$sourcePath" "$Target" /E /COPY:DAT /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
# robocopy exit codes < 8 indicate success (with various copy stats); >= 8 is a real failure.
if ($LASTEXITCODE -ge 8) {
  Fail "robocopy failed copying the Codex package (exit $LASTEXITCODE)."
}
$global:LASTEXITCODE = 0
if (-not (Test-Path -LiteralPath (Join-Path $Target "app\resources\app.asar"))) {
  Fail "Copy completed but $Target\app\resources\app.asar is missing."
}
Write-Ok "Copied"

# --- 6. Patch the loose copy ---------------------------------------------------
Write-Step "Patching app.asar (Chrome plugin) + exe integrity"
& node "$Patcher" --app "$Target" --apply --patch-exe-integrity
if ($LASTEXITCODE -ne 0) {
  Fail "Patcher failed (exit $LASTEXITCODE). The Codex bundle may have changed; check scripts/patch-codex-chrome-windows.mjs."
}
Write-Ok "Patched"

# --- 6b. Sweep temporary patcher artifacts -------------------------------------
# The patcher cleans its own work dir/temp asar on success; this also clears any
# leftovers from older runs (before that cleanup existed).
Write-Step "Cleaning up temporary files"
Get-ChildItem -Path "C:\tmp" -Filter "codex-chrome-patch-*" -Directory -ErrorAction SilentlyContinue |
  ForEach-Object { Remove-Tree $_.FullName }
Get-ChildItem -Path "C:\tmp" -Filter "codex-chrome-patched-*.asar" -File -ErrorAction SilentlyContinue |
  Remove-Item -Force -ErrorAction SilentlyContinue
Write-Ok "Done"

# --- 7. Create / refresh the Desktop shortcut ----------------------------------
$codexExe = Join-Path $Target "app\Codex.exe"
if (-not $NoShortcut) {
  Write-Step "Refreshing Desktop shortcut"
  try {
    $desktop = [Environment]::GetFolderPath("Desktop")
    $lnkPath = Join-Path $desktop $ShortcutName
    $wsh = New-Object -ComObject WScript.Shell
    $lnk = $wsh.CreateShortcut($lnkPath)
    $lnk.TargetPath       = $codexExe
    $lnk.WorkingDirectory = (Split-Path -Parent $codexExe)
    $lnk.IconLocation     = $codexExe
    $lnk.Description       = "Patched Codex with Chrome plugin enabled"
    $lnk.Save()
    Write-Ok "Shortcut: $lnkPath"
  } catch {
    Write-Host "    Could not create shortcut: $($_.Exception.Message)" -ForegroundColor Yellow
  }
}

# --- 8. Launch -----------------------------------------------------------------
if ($NoLaunch) {
  Write-Step "Done (launch skipped)"
  Write-Ok "Patched Codex ready at: $codexExe"
} else {
  Write-Step "Launching patched Codex"
  & powershell -ExecutionPolicy Bypass -File "$Launcher" -AppRoot "$Target"
  if ($LASTEXITCODE -ne 0) { Fail "Launcher failed (exit $LASTEXITCODE)." }
}

Write-Host "`nAll done. Use this same script again after any Codex Store update." -ForegroundColor Cyan
