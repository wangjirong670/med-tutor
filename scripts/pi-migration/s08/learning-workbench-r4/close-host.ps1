function Publish-S07BCloseRequest([string]$CloseRequest,[string]$RunId) {
 if(Test-Path -LiteralPath $CloseRequest){
  $existing=Get-Content -Raw -LiteralPath $CloseRequest|ConvertFrom-Json
  if($existing.runId -ne $RunId -or $existing.request -ne 'close'){throw 'Conflicting existing close request'}
  return 'already-published'
 }
 $temp="$CloseRequest.$RunId.tmp"
 $json=@{runId=$RunId;request='close';at=[DateTimeOffset]::Now.ToString('o')}|ConvertTo-Json -Compress
 [IO.File]::WriteAllText($temp,$json,[Text.UTF8Encoding]::new($false))
 [IO.File]::Move($temp,$CloseRequest)
 return 'published'
}
