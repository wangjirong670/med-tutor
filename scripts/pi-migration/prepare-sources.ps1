param([ValidateSet('execution','acceptance')][string]$Lane='acceptance')
$ErrorActionPreference='Stop'
$project=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$root=Join-Path $project ".study/pi-migration/S01/$Lane"
$art=Join-Path $project 'docs/pi-migration/S01-artifacts'
if(Test-Path "$root/src/pi-gui/package.json"){throw 'Refusing to overwrite existing source export'}
foreach($d in @('src/pi-gui','tools','logs','sandbox')){New-Item -ItemType Directory -Force "$root/$d" | Out-Null}
$research=Join-Path $project '../harness-research'
$fixed=@{'pi-gui'='faf8edd6d7a7e3bf3c508d6f600a22d3821ac108';'pi-hermes-memory'='bb58c12e853a52a4b92b10ff43c0394bca3f17ff'}
foreach($name in $fixed.Keys){if((git -C "$research/$name" rev-parse HEAD) -ne $fixed[$name]){throw 'Research HEAD drift'};git -C "$research/$name" archive --format=tar -o "$root/$name.tar" $fixed[$name];if($LASTEXITCODE -ne 0){throw 'git archive failed'}}
tar -xf "$root/pi-gui.tar" -C "$root/src/pi-gui" --exclude='.claude/skills/testing-windows-desktop' --exclude='.claude/skills/verify-pi-gui' --exclude='CLAUDE.md'
if($LASTEXITCODE -ne 0){throw 'GUI archive extraction failed'}
New-Item -ItemType Directory -Force "$root/src/pi-gui/packages/hermes-memory" | Out-Null
tar -xf "$root/pi-hermes-memory.tar" -C "$root/src/pi-gui/packages/hermes-memory"
if($LASTEXITCODE -ne 0){throw 'Memory archive extraction failed'}
Copy-Item "$art/pnpm-workspace.yaml" "$root/src/pi-gui/pnpm-workspace.yaml"
Copy-Item "$art/pnpm-lock.yaml" "$root/src/pi-gui/pnpm-lock.yaml"
Copy-Item "$art/hermes-package.json" "$root/src/pi-gui/packages/hermes-memory/package.json"
python (Join-Path $PSScriptRoot 'apply-source-edits.py') "$root/src/pi-gui/packages/hermes-memory" "$art/hermes-source-edits.json"
if($LASTEXITCODE -ne 0){throw 'Hash-anchored source edits failed'}
Copy-Item (Join-Path $PSScriptRoot 'sdk-smoke.mjs'),(Join-Path $PSScriptRoot 'network-guard.mjs') "$root/sandbox/"
Copy-Item (Join-Path $PSScriptRoot 'sqlite-probe.cjs') "$root/sqlite-probe.cjs"
Copy-Item (Join-Path $PSScriptRoot 'native-probe.cjs') "$root/native-probe.cjs"
function WriteJob($name,$cwd,$exe,$arguments,$envMap=@{}){[pscustomobject]@{name=$name;cwd=$cwd;exe=$exe;args=$arguments;env=$envMap}|ConvertTo-Json -Depth 5|Set-Content "$root/$name.json" -Encoding utf8}
$node='C:\Program Files\nodejs\node.exe';$pnpm="$root/tools/node_modules/pnpm/bin/pnpm.cjs"
WriteJob 'bootstrap-pnpm' "$root/tools" $node @('C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js','install','--prefix',"$root/tools",'pnpm@10.25.0','--ignore-scripts','--no-audit','--no-fund')
WriteJob 'frozen-install' "$root/src/pi-gui" $node @($pnpm,'install','--frozen-lockfile','--ignore-scripts','--store-dir',"$root/cache/pnpm")
WriteJob 'desktop-build' "$root/src/pi-gui" $node @($pnpm,'--filter','@pi-gui/desktop','run','build')
WriteJob 'memory-build' "$root/src/pi-gui/packages/hermes-memory" $node @("$root/src/pi-gui/packages/hermes-memory/node_modules/typescript/bin/tsc")
WriteJob 'electron-download' "$root/src/pi-gui/node_modules/electron" $node @('install.js')
WriteJob 'sqlite-host' $root $node @("$root/sqlite-probe.cjs")
WriteJob 'sqlite-electron' $root "$root/src/pi-gui/node_modules/electron/dist/electron.exe" @("$root/sqlite-probe.cjs") @{ELECTRON_RUN_AS_NODE='1'}
WriteJob 'native-host' $root $node @("$root/native-probe.cjs")
WriteJob 'native-electron' $root "$root/src/pi-gui/node_modules/electron/dist/electron.exe" @("$root/native-probe.cjs") @{ELECTRON_RUN_AS_NODE='1'}
Write-Output "Prepared $Lane source and jobs; no dependencies installed or SDK loaded."
