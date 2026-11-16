param([Parameter(Mandatory=$true)][string]$EngineConfig,[Parameter(Mandatory=$true)][string]$PreviewExe,[Parameter(Mandatory=$true)][string]$V6Exe,[Parameter(Mandatory=$true)][string]$OutputDir)
$ErrorActionPreference='Stop'
$taskRoot=Split-Path $PSScriptRoot -Parent
$taskShell=(Get-Command pwsh.exe).Source
$taskStart=Join-Path $taskRoot 'scripts\Start-Preview.ps1'
New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
foreach($taskMode in @('v9','v6')){
 $taskLine='@"'+$taskShell+'" -NoProfile -ExecutionPolicy Bypass -File "'+$taskStart+'" -EngineConfig "'+[IO.Path]::GetFullPath($EngineConfig)+'" -PreviewExe "'+[IO.Path]::GetFullPath($PreviewExe)+'" -Engine '+$taskMode+' -V6Exe "'+[IO.Path]::GetFullPath($V6Exe)+'"'
 [IO.File]::WriteAllText((Join-Path $OutputDir ('Start-CK-'+$taskMode+'.cmd')),$taskLine+"`r`n",[Text.UTF8Encoding]::new($false))
}
