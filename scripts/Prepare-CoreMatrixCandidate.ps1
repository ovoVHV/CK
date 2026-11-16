param([string]$Destination='local/core-matrix-engine-repro')
$ErrorActionPreference='Stop'
$taskRepo=Split-Path $PSScriptRoot -Parent
$taskLocal=[IO.Path]::GetFullPath((Join-Path $taskRepo 'local'))
$taskDestination=[IO.Path]::GetFullPath((Join-Path $taskRepo $Destination))
if(-not $taskDestination.StartsWith($taskLocal+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Candidate must be a new directory under repo/local'}
if(Test-Path -LiteralPath $taskDestination){throw 'Destination exists; choose a new candidate directory'}
$taskAudit=Join-Path $taskRepo 'docs/audits/esp32-core-matrix-2026-11-04'
$taskManifest=Get-Content -LiteralPath (Join-Path $taskAudit 'candidate-manifest.json') -Raw | ConvertFrom-Json
foreach($taskRow in $taskManifest.files){
 if((Get-FileHash -LiteralPath (Join-Path $taskRepo $taskRow.file) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $taskRow.baselineSha256){throw ('Baseline source changed: '+$taskRow.file)}
}
New-Item -ItemType Directory -Path $taskDestination | Out-Null
foreach($taskName in @('src','bin','scripts','package.json')){Copy-Item -LiteralPath (Join-Path $taskRepo $taskName) -Destination $taskDestination -Recurse}
$taskRelative=[IO.Path]::GetRelativePath($taskRepo,$taskDestination).Replace('\','/')
$taskPatch=Join-Path $taskAudit 'candidate.patch'
& git -C $taskRepo apply --check ('--directory='+$taskRelative) $taskPatch
if($LASTEXITCODE -ne 0){throw 'Candidate patch check failed'}
& git -C $taskRepo apply ('--directory='+$taskRelative) $taskPatch
if($LASTEXITCODE -ne 0){throw 'Candidate patch failed'}
foreach($taskRow in $taskManifest.files){
 $taskText=[IO.File]::ReadAllText((Join-Path $taskDestination $taskRow.file)).Replace("`r`n","`n")
 $taskDigest=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($taskText))).ToLowerInvariant()
 if($taskDigest -ne $taskRow.candidateLfSha256){throw ('Candidate source differs: '+$taskRow.file)}
}
Write-Output ('Candidate source prepared: '+$taskDestination)
Write-Output 'This does not qualify or enable new Core versions in the installed product.'
