param([ValidateSet('execution','acceptance')][string]$Lane='execution')
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot "../../.study/pi-migration/S01/$Lane"))
$runId=[guid]::NewGuid().ToString()
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'canary.cjs') -Destination "$root/sandbox/canary.cjs"
Set-Content -LiteralPath "$root/sandbox/run-id.txt" -Value $runId -Encoding ascii
$p=[Diagnostics.ProcessStartInfo]::new()
$p.FileName='C:\Program Files\nodejs\node.exe';$p.WorkingDirectory=$root
$p.UseShellExecute=$false;$p.CreateNoWindow=$true;$p.Environment.Clear()
$p.Environment['SystemRoot']='C:\Windows';$p.Environment['WINDIR']='C:\Windows'
foreach($k in @('HOME','USERPROFILE','APPDATA','LOCALAPPDATA')){$p.Environment[$k]="$root/home"}
$p.ArgumentList.Add((Join-Path $PSScriptRoot 'canary-receiver.cjs'));$p.ArgumentList.Add($runId)
$receiver=[Diagnostics.Process]::Start($p)
try {
 $deadline=[DateTime]::UtcNow.AddSeconds(5)
 do {
  Start-Sleep -Milliseconds 50
  $ready=if(Test-Path "$root/logs/receiver-ready.json"){Get-Content "$root/logs/receiver-ready.json" -Raw | ConvertFrom-Json}else{$null}
 } until(($ready.runId -eq $runId -and $ready.ready) -or [DateTime]::UtcNow -ge $deadline)
 if($ready.runId -ne $runId -or -not $ready.ready){throw 'Current-run receiver not ready'}
 $tokenOutput=& (Join-Path $PSScriptRoot 'appcontainer-probe.ps1') -Root "$root/sandbox"
 $tokenOutput | Set-Content "$root/logs/appcontainer-token.json"
 $receiver.WaitForExit()
 $token=$tokenOutput -join "`n" | ConvertFrom-Json
 $probe=Get-Content "$root/sandbox/canary-result.json" -Raw | ConvertFrom-Json
 $result=Get-Content "$root/logs/receiver-result.json" -Raw | ConvertFrom-Json
 $overlap=([DateTimeOffset]$result.started -lt [DateTimeOffset]$probe.started -and [DateTimeOffset]$probe.ended -lt [DateTimeOffset]$result.ended)
 $pass=($probe.runId -eq $runId -and $result.runId -eq $runId -and $overlap -and $result.selfCheckTcp -eq 1 -and $result.selfCheckUdp -eq 1 -and $result.tcpConnections -eq 0 -and $result.udpMarkers -eq 0 -and $probe.tcpExternallyDenied -and $token.tokenIsAppContainer -eq 1 -and $token.capabilityCount -eq 0 -and $token.exitCode -eq 0)
 $gate=[ordered]@{runId=$runId;passed=$pass;overlap=$overlap;token=$token;probe=$probe;receiver=$result;limitation='UDP send callback only local submission; local receiver observes no delivery. External UDP delivery not independently packet-captured. Zero-capability AppContainer is the OS boundary; external TCP/TLS rejection is directly observed.'}
 $gate | ConvertTo-Json -Depth 8 | Set-Content "$root/logs/network-gate.json"
 if(-not $pass){throw 'Network gate failed: SDK execution prohibited'}
 $gate | ConvertTo-Json -Depth 8
} finally {if(-not $receiver.HasExited){$receiver.WaitForExit(15000) | Out-Null}}
