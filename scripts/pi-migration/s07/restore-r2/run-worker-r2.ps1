param([Parameter(Mandatory=$true)][string]$SandboxPath)
$ErrorActionPreference='Stop'
$PSNativeCommandUseErrorActionPreference=$false
$scriptDir=[IO.Path]::GetFullPath($PSScriptRoot)
$project=[IO.Path]::GetFullPath((Join-Path $scriptDir '../../../..'))
$allowedScripts=[IO.Path]::GetFullPath((Join-Path $project 'scripts/pi-migration/s07/restore-r2'))
$allowedEvidence=[IO.Path]::GetFullPath((Join-Path $project '.study/pi-migration/S07/execution-s07a/restore-r2'))
$sandbox=[IO.Path]::GetFullPath($SandboxPath)
$source=[IO.Path]::GetFullPath((Join-Path $allowedScripts 'src/pi-gui'))
$store=[IO.Path]::GetFullPath((Join-Path $allowedEvidence 'store/pnpm/v10'))
$ownerLog=[IO.Path]::GetFullPath((Join-Path $allowedEvidence 'worker-owner-r2.json'))
foreach($p in @($allowedScripts,$allowedEvidence,$sandbox,$source,$store)){if(-not(Test-Path -LiteralPath $p)){throw "Required R2 path missing: $p"}}
if(-not $sandbox.StartsWith($allowedEvidence+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Sandbox is outside R2 evidence root'}
$sandboxReal=& node -e "process.stdout.write(require('node:fs').realpathSync.native(process.argv[1]))" $sandbox
if($LASTEXITCODE -ne 0 -or -not $sandboxReal.StartsWith($allowedEvidence+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Sandbox realpath escaped R2 evidence root'}
$sourceReal=& node -e "process.stdout.write(require('node:fs').realpathSync.native(process.argv[1]))" $source
if($LASTEXITCODE -ne 0 -or -not $sourceReal.StartsWith($allowedScripts+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Source realpath escaped R2 implementation root'}
$storeReal=& node -e "process.stdout.write(require('node:fs').realpathSync.native(process.argv[1]))" $store
if($LASTEXITCODE -ne 0 -or -not $storeReal.StartsWith($allowedEvidence+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Store realpath escaped R2 evidence root'}

. (Join-Path $scriptDir 'container-types-r2.ps1')
Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;
public static class R2Tokens {
 [DllImport("kernel32.dll",SetLastError=true)] public static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
 [DllImport("advapi32.dll",SetLastError=true)] public static extern bool GetTokenInformation(IntPtr token,int kind,IntPtr value,int length,out int returned);
}
'@
function Read-WorkerToken([IntPtr]$Process,[int]$PidValue){
 $token=[IntPtr]::Zero;$isContainer=0;$length=0
 if(-not [S02Container]::OpenProcessToken($Process,8,[ref]$token)){throw "OpenProcessToken failed for own worker pid $PidValue"}
 try{
  if(-not [S02Container]::GetTokenInformation($token,29,[ref]$isContainer,4,[ref]$length)){throw 'TokenIsAppContainer query failed'}
  [void][R2Tokens]::GetTokenInformation($token,30,[IntPtr]::Zero,0,[ref]$length)
  $buf=[Runtime.InteropServices.Marshal]::AllocHGlobal($length)
  try{if(-not [R2Tokens]::GetTokenInformation($token,30,$buf,$length,[ref]$length)){throw 'TokenCapabilities query failed'};$count=[Runtime.InteropServices.Marshal]::ReadInt32($buf)}finally{[Runtime.InteropServices.Marshal]::FreeHGlobal($buf)}
  return [pscustomobject]@{pid=$PidValue;tokenIsAppContainer=$isContainer;tokenCapabilityCount=$count}
 }finally{[void][S02Container]::CloseHandle($token)}
}

$profile='MedTutor.S07A.RestoreR2.Worker.v1';$sid=[IntPtr]::Zero
$hr=[S02Container]::CreateAppContainerProfile($profile,$profile,'S07A R2 offline Pi synthetic worker',[IntPtr]::Zero,0,[ref]$sid)
if($hr -ne 0){$hr=[S02Container]::DeriveAppContainerSidFromAppContainerName($profile,[ref]$sid)}
if($hr -ne 0){throw "AppContainer profile failed: $hr"}
$sidText=[IntPtr]::Zero;[void][S02Container]::ConvertSidToStringSid($sid,[ref]$sidText);$sidString=[Runtime.InteropServices.Marshal]::PtrToStringUni($sidText)
foreach($d in @('profile/agent','profile/electron','home','tmp','logs','workspace','staging','memory','materials')){New-Item -ItemType Directory -Path (Join-Path $sandbox $d) -Force|Out-Null}
$nodeSource='C:\Program Files\nodejs\node.exe';$nodeTarget=Join-Path $sandbox 'runtime/node.exe';New-Item -ItemType Directory -Path (Split-Path -Parent $nodeTarget) -Force|Out-Null;Copy-Item -LiteralPath $nodeSource -Destination $nodeTarget -Force
$nodeHash=(Get-FileHash -LiteralPath $nodeTarget -Algorithm SHA256).Hash.ToLowerInvariant()
foreach($readPath in @($allowedScripts,$source,$store)){
 $acl=Get-Acl -LiteralPath $readPath
 $hasGrant=@($acl.Access|Where-Object {$_.IdentityReference.Value -eq $sidString -and $_.FileSystemRights.ToString().Contains('ReadAndExecute') -and $_.InheritanceFlags.ToString().Contains('ContainerInherit') -and $_.InheritanceFlags.ToString().Contains('ObjectInherit')}).Count -gt 0
 if(-not $hasGrant){
  & icacls.exe ('\\?\'+$readPath) /grant "*${sidString}:(OI)(CI)RX" /T /Q|Out-Null
  if($LASTEXITCODE -ne 0){throw "R2 worker read ACL failed: $readPath"}
 }
}
& icacls.exe ('\\?\'+$sandbox) /grant "*${sidString}:(OI)(CI)F" /T /Q|Out-Null
if($LASTEXITCODE -ne 0){throw 'R2 sandbox write ACL failed'}
& icacls.exe ('\\?\'+$sandbox) /setintegritylevel '(OI)(CI)L' /T /Q|Out-Null
if($LASTEXITCODE -ne 0){throw 'R2 sandbox low integrity ACL failed'}

$runId=[guid]::NewGuid().ToString()
$envMap=@{
 SystemRoot='C:\Windows';WINDIR='C:\Windows';PATH='C:\Windows\System32;C:\Windows'
 HOME=(Join-Path $sandbox 'home');USERPROFILE=(Join-Path $sandbox 'home');APPDATA=(Join-Path $sandbox 'home');LOCALAPPDATA=(Join-Path $sandbox 'home')
 TEMP=(Join-Path $sandbox 'tmp');TMP=(Join-Path $sandbox 'tmp')
 PI_CODING_AGENT_DIR=(Join-Path $sandbox 'profile/agent');PI_APP_USER_DATA_DIR=(Join-Path $sandbox 'profile/electron');PI_APP_INITIAL_WORKSPACES=(Join-Path $sandbox 'workspace')
 S07A_R2_RUN_ID=$runId;R2_SANDBOX=$sandbox;R2_SOURCE=$source;R2_STORE=$store
 NODE_OPTIONS='--preserve-symlinks --preserve-symlinks-main'
}
$block=(($envMap.Keys|Sort-Object|ForEach-Object{"$_=$($envMap[$_])"})-join "`0")+"`0`0"
$envPtr=[Runtime.InteropServices.Marshal]::StringToHGlobalUni($block)
$caps=[S02Container+SECURITY_CAPABILITIES]::new();$caps.AppContainerSid=$sid;$caps.Capabilities=[IntPtr]::Zero;$caps.CapabilityCount=0
$capSize=[Runtime.InteropServices.Marshal]::SizeOf($caps);$capPtr=[Runtime.InteropServices.Marshal]::AllocHGlobal($capSize);[Runtime.InteropServices.Marshal]::StructureToPtr($caps,$capPtr,$false)
$size=[IntPtr]::Zero;[void][S02Container]::InitializeProcThreadAttributeList([IntPtr]::Zero,1,0,[ref]$size)
$attrs=[Runtime.InteropServices.Marshal]::AllocHGlobal($size)
if(-not [S02Container]::InitializeProcThreadAttributeList($attrs,1,0,[ref]$size)){throw 'Attribute list initialization failed'}
if(-not [S02Container]::UpdateProcThreadAttribute($attrs,0,[IntPtr]0x20009,$capPtr,[IntPtr]$capSize,[IntPtr]::Zero,[IntPtr]::Zero)){throw 'AppContainer capabilities attribute failed'}
$si=[S02Container+STARTUPINFOEX]::new();$inner=[S02Container+STARTUPINFO]::new();$inner.cb=[Runtime.InteropServices.Marshal]::SizeOf($si);$si.StartupInfo=$inner;$si.lpAttributeList=$attrs
$entry=Join-Path $scriptDir 'r2-worker.mjs';$cmd=[Text.StringBuilder]::new('"'+$nodeTarget+'" --preserve-symlinks --preserve-symlinks-main "'+$entry+'"')
$pi=[S02Container+PROCESS_INFORMATION]::new()
if(-not [S02Container]::CreateProcess($nodeTarget,$cmd,[IntPtr]::Zero,[IntPtr]::Zero,$false,0x00080400,$envPtr,$sandbox,[ref]$si,[ref]$pi)){throw "R2 worker launch failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"}
$token=Read-WorkerToken $pi.hProcess $pi.dwProcessId
if($token.tokenIsAppContainer -ne 1 -or $token.tokenCapabilityCount -ne 0){[void][S02Container]::TerminateProcess($pi.hProcess,125);throw 'R2 worker token is not cap0'}
$workerReady=Join-Path $sandbox 'worker-ready.json';$workerResult=Join-Path $sandbox 'worker-result.json';$closeRequest=Join-Path $sandbox 'close-request.json';$closeAck=Join-Path $sandbox 'close-ack.json'
$record=[ordered]@{runId=$runId;pid=$pi.dwProcessId;profile=$profile;sid=$sidString;startedAt=[DateTimeOffset]::Now.ToString('o');nodeExe=$nodeTarget;nodeSha256=$nodeHash;source=$sourceReal;store=$storeReal;sandbox=$sandboxReal;token=$token;capabilitiesPassed=@();environmentKeys=@($envMap.Keys|Sort-Object);closeProtocol='pending'}
$deadline=[DateTime]::UtcNow.AddSeconds(90);$exit=[uint32]259
do{Start-Sleep -Milliseconds 150;if(Test-Path -LiteralPath $workerResult){break};[void][S02Container]::GetExitCodeProcess($pi.hProcess,[ref]$exit)}until($exit -ne 259 -or [DateTime]::UtcNow -gt $deadline)
if(-not(Test-Path -LiteralPath $workerResult)){[void][S02Container]::TerminateProcess($pi.hProcess,124);throw "R2 worker did not produce result; exit=$exit"}
$ready=Get-Content -LiteralPath $workerReady -Raw|ConvertFrom-Json
$result=Get-Content -LiteralPath $workerResult -Raw|ConvertFrom-Json
if($ready.runId -ne $runId -or $ready.pid -ne $pi.dwProcessId -or $result.runId -ne $runId -or $result.pid -ne $pi.dwProcessId){[void][S02Container]::TerminateProcess($pi.hProcess,123);throw 'R2 worker runId/PID ownership mismatch'}
@{runId=$runId;request='close';at=[DateTimeOffset]::Now.ToString('o')}|ConvertTo-Json|Set-Content -LiteralPath $closeRequest -Encoding utf8
$deadline=[DateTime]::UtcNow.AddSeconds(15);$exit=[uint32]259
do{Start-Sleep -Milliseconds 100;[void][S02Container]::GetExitCodeProcess($pi.hProcess,[ref]$exit)}until(($exit -ne 259 -and (Test-Path -LiteralPath $closeAck)) -or [DateTime]::UtcNow -gt $deadline)
$record.closeAck=if(Test-Path -LiteralPath $closeAck){Get-Content -LiteralPath $closeAck -Raw|ConvertFrom-Json}else{$null};$record.closeProtocol=if($record.closeAck -and $record.closeAck.closed){'closed'}else{'failed'};$record.exitCode=$exit;$record.completedAt=[DateTimeOffset]::Now.ToString('o');$record.resultPassed=$result.passed
$record|ConvertTo-Json -Depth 8|Set-Content -LiteralPath $ownerLog -Encoding utf8
if($exit -eq 259){[void][S02Container]::TerminateProcess($pi.hProcess,122);throw 'R2 worker failed to close after protocol request'}
[void][S02Container]::CloseHandle($pi.hThread);[void][S02Container]::CloseHandle($pi.hProcess);[S02Container]::DeleteProcThreadAttributeList($attrs)
$record|ConvertTo-Json -Depth 8
if(-not $record.resultPassed -or $record.closeProtocol -ne 'closed' -or $exit -ne 0){throw "R2 worker failed resultPassed=$($record.resultPassed) close=$($record.closeProtocol) exit=$exit"}
