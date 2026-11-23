param(
  [string]$Phase = 'default',
  [string]$SandboxPath = ''
)
$ErrorActionPreference = 'Stop'

$scriptDir = [IO.Path]::GetFullPath($PSScriptRoot)
$project = [IO.Path]::GetFullPath((Join-Path $scriptDir '../../../..'))
$source = [IO.Path]::GetFullPath((Join-Path $project 'scripts/pi-migration/s07/restore-r2/src/pi-gui'))

if (-not $SandboxPath) {
  $SandboxPath = Join-Path $project '.study/pi-migration/workbench-sandbox'
}
$sandbox = [IO.Path]::GetFullPath($SandboxPath)

$methodSource = Join-Path $scriptDir 'method-context.json'
if (-not (Test-Path -LiteralPath $methodSource)) {
  throw "Required method-context.json missing: $methodSource"
}
if (-not (Test-Path -LiteralPath $source)) {
  throw "Required pi-gui source missing: $source"
}

foreach ($stale in @('close-request.json', 'close-ack.json')) {
  $stalePath = Join-Path $sandbox $stale
  if (Test-Path -LiteralPath $stalePath) {
    Remove-Item -LiteralPath $stalePath -Force
  }
}

foreach ($d in @('profile/agent', 'profile/electron', 'home', 'home/Desktop', 'tmp', 'logs', 'workspace', 'staging', 'memory', 'materials', 'study', 'history-projection', 'sessions-native', 'registry')) {
  New-Item -ItemType Directory -Path (Join-Path $sandbox $d) -Force | Out-Null
}
Copy-Item -LiteralPath $methodSource -Destination (Join-Path $sandbox 'method-context.json') -Force

$runId = [guid]::NewGuid().ToString()
$registryDir = Join-Path $sandbox 'registry'

$env:PI_CODING_AGENT_DIR = Join-Path $sandbox 'profile/agent'
$env:PI_APP_USER_DATA_DIR = Join-Path $sandbox 'profile/electron'
$env:PI_APP_INITIAL_WORKSPACES = Join-Path $sandbox 'workspace'
$env:S02_RUN_ID = $runId
$env:S07B_RUN_ID = $runId
$env:S07B_PHASE = $Phase
$env:S07B_SANDBOX = $sandbox
$env:S07B_SOURCE = $source
$env:S07C_REGISTRY_DIR = $registryDir
$env:NODE_OPTIONS = '--preserve-symlinks --preserve-symlinks-main'

$entry = Join-Path $scriptDir 'worker.mjs'
$nodeExe = (Get-Command node -ErrorAction Stop).Source

Push-Location $sandbox
try {
  & $nodeExe --preserve-symlinks --preserve-symlinks-main $entry
  if ($LASTEXITCODE -ne 0) {
    throw "Worker exited with code $LASTEXITCODE"
  }
} finally {
  Pop-Location
}
