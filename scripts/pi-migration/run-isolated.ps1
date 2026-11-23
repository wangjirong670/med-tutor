param([Parameter(Mandatory=$true)][string]$Job,[ValidateSet('execution','acceptance')][string]$Lane='execution')
$ErrorActionPreference='Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$experimentRoot = Join-Path $projectRoot ".study/pi-migration/S01/$Lane"
$j=Get-Content -LiteralPath $Job -Raw | ConvertFrom-Json
$working=[IO.Path]::GetFullPath($j.cwd)
if($working -ne $experimentRoot -and -not $working.StartsWith($experimentRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'cwd outside selected S01 lane'}
foreach($d in @('home','profile/agent','profile/electron','tmp','logs','cache','tools','workspace')){New-Item -ItemType Directory -Force (Join-Path $experimentRoot $d) | Out-Null}
$emptyConfig=Join-Path $experimentRoot 'empty.npmrc'
if(-not (Test-Path $emptyConfig)){Set-Content -LiteralPath $emptyConfig -Value '' -Encoding ascii}
$globalConfig=Join-Path $experimentRoot 'empty-global.npmrc'
if(-not (Test-Path $globalConfig)){Set-Content -LiteralPath $globalConfig -Value '' -Encoding ascii}
$p=[Diagnostics.ProcessStartInfo]::new()
$p.FileName=$j.exe
$p.WorkingDirectory=$working
$p.UseShellExecute=$false
$p.CreateNoWindow=$true
$p.RedirectStandardOutput=$true
$p.RedirectStandardError=$true
$p.Environment.Clear()
foreach($k in @('SystemRoot','WINDIR','ComSpec','PATHEXT','NUMBER_OF_PROCESSORS','PROCESSOR_ARCHITECTURE')){if([Environment]::GetEnvironmentVariable($k)){$p.Environment[$k]=[Environment]::GetEnvironmentVariable($k)}}
$p.Environment['PATH']='C:\Program Files\nodejs;C:\Windows\System32;C:\Windows'
foreach($k in @('HOME','USERPROFILE','APPDATA','LOCALAPPDATA')){$p.Environment[$k]=Join-Path $experimentRoot 'home'}
foreach($k in @('TEMP','TMP')){$p.Environment[$k]=Join-Path $experimentRoot 'tmp'}
$p.Environment['PI_CODING_AGENT_DIR']=Join-Path $experimentRoot 'profile/agent'
$p.Environment['PI_APP_USER_DATA_DIR']=Join-Path $experimentRoot 'profile/electron'
$p.Environment['npm_config_userconfig']=$emptyConfig
$p.Environment['npm_config_globalconfig']=$globalConfig
$p.Environment['npm_config_cache']=Join-Path $experimentRoot 'cache/npm'
$p.Environment['npm_config_registry']='https://registry.npmjs.org/'
$p.Environment['CI']='true'
$p.Environment['NO_COLOR']='1'
$p.Environment['PNPM_HOME']=Join-Path $experimentRoot 'tools'
if($j.env){foreach($prop in $j.env.PSObject.Properties){if($prop.Name -notin @('ELECTRON_RUN_AS_NODE')){throw 'unapproved job env'};$p.Environment[$prop.Name]=[string]$prop.Value}}
foreach($a in $j.args){$p.ArgumentList.Add([string]$a)}
$proc=[Diagnostics.Process]::new(); $proc.StartInfo=$p
$started=[DateTimeOffset]::Now.ToString('o')
[void]$proc.Start()
$outTask=$proc.StandardOutput.ReadToEndAsync(); $errTask=$proc.StandardError.ReadToEndAsync()
$proc.WaitForExit()
$out=$outTask.GetAwaiter().GetResult(); $err=$errTask.GetAwaiter().GetResult()
$record=[ordered]@{name=$j.name;started=$started;ended=[DateTimeOffset]::Now.ToString('o');exe=$j.exe;args=$j.args;cwd=$working;environmentKeys=@($p.Environment.Keys | Sort-Object);exitCode=$proc.ExitCode;stdout=$out;stderr=$err}
$logPath=Join-Path $experimentRoot "logs/$($j.name).json"
if(Test-Path -LiteralPath $logPath){$logPath=Join-Path $experimentRoot "logs/$($j.name)-$([DateTimeOffset]::Now.ToUnixTimeMilliseconds()).json"}
$record | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 $logPath
Write-Output $out
if($err){Write-Output $err}
exit $proc.ExitCode
