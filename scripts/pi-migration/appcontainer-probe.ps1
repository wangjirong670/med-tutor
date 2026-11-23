# S01 infrastructure probe only: no SDK import. Fail closed if creation fails.
param([Parameter(Mandatory=$true)][string]$Root,[ValidateSet('canary.cjs','sdk-smoke.mjs')][string]$Script='canary.cjs')
$ErrorActionPreference='Stop'
$Root=[IO.Path]::GetFullPath($Root)
$stepRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../.study/pi-migration/S01'))
$lane=Split-Path (Split-Path $Root -Parent) -Leaf
if($lane -notin @('execution','acceptance') -or $Root -ne (Join-Path $stepRoot "$lane/sandbox")){throw 'Unexpected sandbox root'}
if($Script -ne 'canary.cjs'){
 $gate=Get-Content (Join-Path $Root '../logs/network-gate.json') -Raw | ConvertFrom-Json
 if(-not $gate.passed -or -not $gate.overlap){throw 'SDK prohibited before network gate'}
}
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class S01Container {
 [StructLayout(LayoutKind.Sequential)] public struct SECURITY_CAPABILITIES {public IntPtr AppContainerSid; public IntPtr Capabilities; public int CapabilityCount; public int Reserved;}
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] public struct STARTUPINFO {public int cb;public string lpReserved;public string lpDesktop;public string lpTitle;public int dwX;public int dwY;public int dwXSize;public int dwYSize;public int dwXCountChars;public int dwYCountChars;public int dwFillAttribute;public int dwFlags;public short wShowWindow;public short cbReserved2;public IntPtr lpReserved2;public IntPtr hStdInput;public IntPtr hStdOutput;public IntPtr hStdError;}
 [StructLayout(LayoutKind.Sequential)] public struct STARTUPINFOEX {public STARTUPINFO StartupInfo; public IntPtr lpAttributeList;}
 [StructLayout(LayoutKind.Sequential)] public struct PROCESS_INFORMATION {public IntPtr hProcess;public IntPtr hThread;public int dwProcessId;public int dwThreadId;}
 [DllImport("userenv.dll",CharSet=CharSet.Unicode)] public static extern int CreateAppContainerProfile(string name,string display,string description,IntPtr caps,int count,out IntPtr sid);
 [DllImport("userenv.dll",CharSet=CharSet.Unicode)] public static extern int DeriveAppContainerSidFromAppContainerName(string name,out IntPtr sid);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern bool ConvertSidToStringSid(IntPtr sid,out IntPtr str);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,int flags,ref IntPtr size);
 [DllImport("kernel32.dll",SetLastError=true)] public static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr size,IntPtr previous,IntPtr returned);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern bool CreateProcess(string app,System.Text.StringBuilder cmd,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref STARTUPINFOEX startup,out PROCESS_INFORMATION proc);
 [DllImport("kernel32.dll")] public static extern uint WaitForSingleObject(IntPtr handle,uint ms);
 [DllImport("kernel32.dll")] public static extern bool GetExitCodeProcess(IntPtr handle,out uint code);
 [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll")] public static extern bool TerminateProcess(IntPtr handle,uint code);
 [DllImport("advapi32.dll",SetLastError=true)] public static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
 [DllImport("advapi32.dll",SetLastError=true)] public static extern bool GetTokenInformation(IntPtr token,int kind,out int value,int length,out int returned);
 [DllImport("kernel32.dll")] public static extern void DeleteProcThreadAttributeList(IntPtr list);
}
'@
$name=if($lane -eq 'execution'){'MedTutor.S01.Offline.v1'}else{'MedTutor.S01.Offline.Acceptance.v1'}
$sid=[IntPtr]::Zero
$hr=[S01Container]::CreateAppContainerProfile($name,$name,'Offline S01 fixture runtime', [IntPtr]::Zero,0,[ref]$sid)
if($hr -ne 0){$hr=[S01Container]::DeriveAppContainerSidFromAppContainerName($name,[ref]$sid)}
if($hr -ne 0){throw "AppContainer SID failed: $hr"}
$sidText=[IntPtr]::Zero
if(-not [S01Container]::ConvertSidToStringSid($sid,[ref]$sidText)){throw 'SID conversion failed'}
$sidString=[Runtime.InteropServices.Marshal]::PtrToStringUni($sidText)
if($Script -ne 'canary.cjs'){
 $source=[IO.Path]::GetFullPath((Join-Path $Root '../src'))
 $readAcl=& icacls.exe $source /grant "*${sidString}:(OI)(CI)RX" /Q 2>&1
 if($LASTEXITCODE -ne 0){throw "Read-source ACL failed: $readAcl"}
}
foreach($d in @('runtime','home','tmp','profile/agent','profile/electron')){New-Item -ItemType Directory -Force (Join-Path $Root $d) | Out-Null}
$aclOutput = & icacls.exe $Root /grant "*${sidString}:(OI)(CI)F" /T /Q 2>&1
if($LASTEXITCODE -ne 0){throw "AppContainer ACL grant failed: $aclOutput"}
$integrityOutput = & icacls.exe $Root /setintegritylevel '(OI)(CI)L' /T /Q 2>&1
if($LASTEXITCODE -ne 0){throw "AppContainer integrity failed: $integrityOutput"}
$runtime=Join-Path $Root 'runtime'
New-Item -ItemType Directory -Force $runtime | Out-Null
Copy-Item -LiteralPath 'C:\Program Files\nodejs\node.exe' -Destination (Join-Path $runtime 'node.exe')
$caps=[S01Container+SECURITY_CAPABILITIES]::new();$caps.AppContainerSid=$sid
$capSize=[Runtime.InteropServices.Marshal]::SizeOf($caps)
$capPtr=[Runtime.InteropServices.Marshal]::AllocHGlobal($capSize)
[Runtime.InteropServices.Marshal]::StructureToPtr($caps,$capPtr,$false)
$size=[IntPtr]::Zero
[void][S01Container]::InitializeProcThreadAttributeList([IntPtr]::Zero,1,0,[ref]$size)
$attrs=[Runtime.InteropServices.Marshal]::AllocHGlobal($size)
if(-not [S01Container]::InitializeProcThreadAttributeList($attrs,1,0,[ref]$size)){throw 'Attribute init failed'}
if(-not [S01Container]::UpdateProcThreadAttribute($attrs,0,[IntPtr]0x20009,$capPtr,[IntPtr]$capSize,[IntPtr]::Zero,[IntPtr]::Zero)){throw 'Security capability attribute failed'}
$si=[S01Container+STARTUPINFOEX]::new();$inner=[S01Container+STARTUPINFO]::new();$inner.cb=[Runtime.InteropServices.Marshal]::SizeOf($si);$si.StartupInfo=$inner;$si.lpAttributeList=$attrs
$envMap=@{SystemRoot='C:\Windows';WINDIR='C:\Windows';PATH="$runtime;C:\Windows\System32";HOME="$Root/home";USERPROFILE="$Root/home";APPDATA="$Root/home";LOCALAPPDATA="$Root/home";TEMP="$Root/tmp";TMP="$Root/tmp";PI_CODING_AGENT_DIR="$Root/profile/agent";PI_APP_USER_DATA_DIR="$Root/profile/electron"}
$block=(($envMap.Keys | Sort-Object | ForEach-Object {"$_=$($envMap[$_])"}) -join "`0")+"`0`0"
$envPtr=[Runtime.InteropServices.Marshal]::StringToHGlobalUni($block)
$exe=Join-Path $runtime 'node.exe'
$cmd=[Text.StringBuilder]::new('"'+$exe+'" --preserve-symlinks --preserve-symlinks-main "'+(Join-Path $Root $Script)+'"')
$pi=[S01Container+PROCESS_INFORMATION]::new()
if(-not [S01Container]::CreateProcess($exe,$cmd,[IntPtr]::Zero,[IntPtr]::Zero,$false,0x00080400,$envPtr,$Root,[ref]$si,[ref]$pi)){throw "AppContainer launch failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error()); startupSize=$($si.StartupInfo.cb); capSize=$capSize; attrSize=$size"}
$token=[IntPtr]::Zero;$isContainer=0;$returned=0
if(-not [S01Container]::OpenProcessToken($pi.hProcess,8,[ref]$token)){throw 'Token open failed'}
if(-not [S01Container]::GetTokenInformation($token,29,[ref]$isContainer,4,[ref]$returned)){throw 'Token query failed'}
[void][S01Container]::CloseHandle($token)
$wait=[S01Container]::WaitForSingleObject($pi.hProcess,45000)
if($wait -eq 258){[void][S01Container]::TerminateProcess($pi.hProcess,124);[void][S01Container]::WaitForSingleObject($pi.hProcess,5000)}
$exitCode=[uint32]0;[void][S01Container]::GetExitCodeProcess($pi.hProcess,[ref]$exitCode)
[void][S01Container]::CloseHandle($pi.hThread);[void][S01Container]::CloseHandle($pi.hProcess)
[S01Container]::DeleteProcThreadAttributeList($attrs)
$record=@{name=$name;sid=$sidString;script=$Script;pid=$pi.dwProcessId;capabilityCount=0;tokenIsAppContainer=$isContainer;wait=$wait;exitCode=$exitCode;resultFile=(Join-Path $Root $(if($Script -eq 'canary.cjs'){'canary-result.json'}else{'sdk-result.json'}))}
$record | ConvertTo-Json
if($isContainer -ne 1 -or $exitCode -ne 0 -or $wait -ne 0){throw 'AppContainer fixture process failed; see result file'}
