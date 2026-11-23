param(
  [string]$DataDir = "",
  [string]$BackupDir = "",
  [int]$KeepCount = 10
)
$ErrorActionPreference = "Stop"

if ($KeepCount -lt 1) {
  throw "KeepCount must be at least 1."
}

$scriptDir = [IO.Path]::GetFullPath($PSScriptRoot)
$projectRoot = [IO.Path]::GetFullPath((Join-Path $scriptDir ".."))

if (-not $DataDir) {
  $DataDir = Join-Path $projectRoot ".study\personal"
}
$sourceRoot = [IO.Path]::GetFullPath($DataDir)

if (-not $BackupDir) {
  $BackupDir = Join-Path $projectRoot ".study\backups"
}
$backupRoot = [IO.Path]::GetFullPath($BackupDir)

foreach ($sub in @("agent", "user-data", "learning-data", "workspace")) {
  New-Item -ItemType Directory -Path (Join-Path $sourceRoot $sub) -Force | Out-Null
}
New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$zipName = "personal-backup-$timestamp.zip"
$zipPath = Join-Path $backupRoot $zipName
$suffix = 1
while (Test-Path -LiteralPath $zipPath) {
  $zipName = "personal-backup-$timestamp-$suffix.zip"
  $zipPath = Join-Path $backupRoot $zipName
  $suffix++
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory(
  $sourceRoot,
  $zipPath,
  [System.IO.Compression.CompressionLevel]::Optimal,
  $false
)

$existingBackups = Get-ChildItem -LiteralPath $backupRoot -Filter "personal-backup-*.zip" -File |
  Sort-Object -Property LastWriteTime, Name -Descending

$removedCount = 0
if ($existingBackups.Count -gt $KeepCount) {
  $toRemove = $existingBackups | Select-Object -Skip $KeepCount
  foreach ($old in $toRemove) {
    Remove-Item -LiteralPath $old.FullName -Force
    $removedCount++
  }
}

$retainedCount = [Math]::Min($existingBackups.Count, $KeepCount)
$zipInfo = Get-Item -LiteralPath $zipPath
$sizeKb = [Math]::Round($zipInfo.Length / 1KB, 2)
$sizeMb = [Math]::Round($zipInfo.Length / 1MB, 2)
$sizeText = if ($zipInfo.Length -ge 1MB) { "$sizeMb MB ($($zipInfo.Length) bytes)" } else { "$sizeKb KB ($($zipInfo.Length) bytes)" }

Write-Host "Personal data backup completed."
Write-Host "SourceDir: $sourceRoot"
Write-Host "BackupPath: $zipPath"
Write-Host "BackupSize: $sizeText"
Write-Host "RetainedBackups: $retainedCount (removed old: $removedCount)"
