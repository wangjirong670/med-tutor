param(
  [string]$DataDir = "",
  [switch]$OfflineMock,
  [switch]$BuildFirst
)
$ErrorActionPreference = "Stop"

$scriptDir = [IO.Path]::GetFullPath($PSScriptRoot)
$projectRoot = [IO.Path]::GetFullPath((Join-Path $scriptDir ".."))
$piGuiRoot = Join-Path $projectRoot "scripts\pi-migration\s07\restore-r2\src\pi-gui"
$desktopDir = Join-Path $piGuiRoot "apps\desktop"
$mainEntry = Join-Path $desktopDir "out\main\main.js"
$electronExe = Join-Path $projectRoot ".study\pi-migration\runtime\electron\electron.exe"

if (-not (Test-Path -LiteralPath $electronExe)) {
  throw "Electron runtime not found at: $electronExe"
}

# Ensure workspace package junctions exist inside pi-gui node_modules
$pkgs = @("catalogs", "extension-ui", "hermes-memory", "pi-sdk-driver", "session-driver")
foreach ($nmRoot in @(
  (Join-Path $piGuiRoot "node_modules\@pi-gui"),
  (Join-Path $desktopDir "node_modules\@pi-gui"),
  (Join-Path $piGuiRoot "packages\pi-sdk-driver\node_modules\@pi-gui")
)) {
  New-Item -ItemType Directory -Path $nmRoot -Force | Out-Null
  foreach ($p in $pkgs) {
    $link = Join-Path $nmRoot $p
    $target = Join-Path $piGuiRoot "packages\$p"
    if (-not (Test-Path -LiteralPath $link) -and (Test-Path -LiteralPath $target)) {
      New-Item -ItemType Junction -Path $link -Value $target | Out-Null
    }
  }
}
$ignoreLink = Join-Path $desktopDir "node_modules\ignore"
$ignoreTarget = Join-Path $piGuiRoot "node_modules\ignore"
if (-not (Test-Path -LiteralPath $ignoreLink) -and (Test-Path -LiteralPath $ignoreTarget)) {
  New-Item -ItemType Junction -Path $ignoreLink -Value $ignoreTarget | Out-Null
}

if ($BuildFirst -or -not (Test-Path -LiteralPath $mainEntry)) {
  Write-Host "Building med-tutor desktop..."
  & node (Join-Path $scriptDir "build-desktop.mjs")
  if ($LASTEXITCODE -ne 0) {
    throw "Desktop build failed with code $LASTEXITCODE"
  }
}

if (-not $DataDir) {
  $DataDir = Join-Path $projectRoot ".study\personal"
}
$root = [IO.Path]::GetFullPath($DataDir)

foreach ($sub in @("agent", "user-data", "learning-data", "workspace")) {
  New-Item -ItemType Directory -Path (Join-Path $root $sub) -Force | Out-Null
}

$env:MED_TUTOR_ROOT = $projectRoot
$env:S07B_SOURCE = $piGuiRoot
$env:S07B_DATA_ROOT = Join-Path $root "learning-data"
$env:PI_CODING_AGENT_DIR = Join-Path $root "agent"
$env:PI_APP_USER_DATA_DIR = Join-Path $root "user-data"
$env:PI_APP_INITIAL_WORKSPACES = Join-Path $root "workspace"
$env:NODE_PATH = Join-Path $piGuiRoot "node_modules"

if ($OfflineMock) {
  $env:MED_TUTOR_OFFLINE_MOCK = "1"
} else {
  Remove-Item Env:MED_TUTOR_OFFLINE_MOCK -ErrorAction SilentlyContinue
}

Start-Process -FilePath $electronExe -ArgumentList @($mainEntry) -WorkingDirectory $desktopDir -PassThru |
  Select-Object Id, ProcessName, @{Name="DataDir";Expression={$root}}, @{Name="OfflineMock";Expression={[bool]$OfflineMock}}
