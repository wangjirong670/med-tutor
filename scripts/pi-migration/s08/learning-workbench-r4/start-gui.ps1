param(
  [string]$SandboxPath = '',
  [string]$Phase = 'default'
)
$ErrorActionPreference = 'Stop'

$scriptDir = [IO.Path]::GetFullPath($PSScriptRoot)
$project = [IO.Path]::GetFullPath((Join-Path $scriptDir '../../../..'))
$source = [IO.Path]::GetFullPath((Join-Path $project 'scripts/pi-migration/s07/restore-r2/src/pi-gui'))
$electronExe = Join-Path $project '.study/pi-migration/runtime/electron/electron.exe'

if (-not $SandboxPath) {
  $SandboxPath = Join-Path $project '.study/pi-migration/workbench-sandbox'
}
$root = [IO.Path]::GetFullPath($SandboxPath)

if (-not (Test-Path -LiteralPath $electronExe)) {
  throw "Electron runtime missing: $electronExe"
}

$ready = Get-Content -Raw (Join-Path $root 'mailbox/ready.json') | ConvertFrom-Json
$runId = [guid]::NewGuid().ToString()
$registryDir = Join-Path $root 'registry'
New-Item -ItemType Directory -Path $registryDir -Force | Out-Null

$env:PI_CODING_AGENT_DIR = Join-Path $root 'profile/gui-empty-agent'
$env:PI_APP_USER_DATA_DIR = Join-Path $root 'profile/electron'
$env:PI_APP_INITIAL_WORKSPACES = Join-Path $root 'workspace'
$env:S02_RUN_ID = $runId
$env:S08B_REGISTRY_DIR = $registryDir
$env:S08B_SCRIPT_DIR = $scriptDir
$env:NODE_PATH = Join-Path $source 'node_modules'

$entry = Join-Path $root 'gui-entry.cjs'
if (-not (Test-Path -LiteralPath $entry)) {
  Copy-Item -LiteralPath (Join-Path $scriptDir 'gui-entry.cjs') -Destination $entry -Force
}

$logFile = Join-Path $root "logs/chromium-$runId.log"
Push-Location $root
try {
  Start-Process -FilePath $electronExe -ArgumentList @(
    '--disable-gpu',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-crash-reporter',
    '--enable-logging=file',
    "--log-file=$logFile",
    $entry
  ) -WorkingDirectory $root -PassThru | Select-Object Id, ProcessName, @{Name='RunId';Expression={$runId}}, @{Name='WorkerRunId';Expression={$ready.runId}}
} finally {
  Pop-Location
}
