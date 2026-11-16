param([Parameter(Mandatory=$true)][string]$PreviewDir,[Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference='Stop'
$taskRoot=Split-Path $PSScriptRoot -Parent
$taskOut=[IO.Path]::GetFullPath($Destination)
New-Item -ItemType Directory -Path $taskOut -Force | Out-Null
$taskStage=Join-Path $taskOut ('stage-'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path (Join-Path $taskStage 'engine') -Force | Out-Null
foreach($taskPart in @('src','bin','native','scripts','tests','docs','provenance')){Copy-Item -LiteralPath (Join-Path $taskRoot $taskPart) -Destination (Join-Path $taskStage "engine\$taskPart") -Recurse}
foreach($taskPart in @('README.md','package.json','config.example.json')){Copy-Item -LiteralPath (Join-Path $taskRoot $taskPart) -Destination (Join-Path $taskStage "engine\$taskPart")}
Copy-Item -LiteralPath $PreviewDir -Destination (Join-Path $taskStage 'desktop-preview') -Recurse
# Machine-local launchers refer to this development workspace; packaged users
# generate their own after configuring the installed asset store.
Get-ChildItem -LiteralPath (Join-Path $taskStage 'desktop-preview') -Filter 'Start-CK-*.cmd' | ForEach-Object {Remove-Item -LiteralPath $_.FullName}
$taskManifest=@(Get-ChildItem -LiteralPath $taskStage -File -Recurse | ForEach-Object {[pscustomobject]@{path=[IO.Path]::GetRelativePath($taskStage,$_.FullName);bytes=$_.Length;sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}})
$taskManifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $taskStage 'files.sha256.json') -Encoding utf8NoBOM
$taskArchive=Join-Path $taskOut 'CK-Build-Engine-V9.0-alpha.1-preview.zip'
if(Test-Path -LiteralPath $taskArchive){throw 'Archive already exists; preserve existing release evidence'}
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory($taskStage,$taskArchive,[IO.Compression.CompressionLevel]::Optimal,$false)
Get-FileHash -LiteralPath $taskArchive -Algorithm SHA256
Write-Output "Staging retained: $taskStage"
