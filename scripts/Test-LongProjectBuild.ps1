param([Parameter(Mandatory)][string]$Package,[Parameter(Mandatory)][string]$EngineConfig,[Parameter(Mandatory)][string]$Output)
$ErrorActionPreference='Stop'
if(Test-Path -LiteralPath $Output){throw 'Use a new evidence directory'}
$pkg=(Resolve-Path -LiteralPath $Package).Path
$cfg=Get-Content -Raw -LiteralPath $EngineConfig|ConvertFrom-Json
$slot=(New-Item -ItemType Directory -Path (Join-Path $Output '中文工程目录-长路径回归-图形化编译')).FullName
foreach($leaf in 'evidence','desktop','projects','webview'){New-Item -ItemType Directory -Path (Join-Path $slot $leaf)|Out-Null}
$cfg.engineVersion=(Get-Content -Raw -LiteralPath "$pkg/engine/package.json"|ConvertFrom-Json).version
$cfg.paths.node="$pkg/engine/runtime/node.exe";$cfg.paths.ninja="$pkg/engine/runtime/ninja.exe";$cfg.paths.cli="$pkg/desktop/bin/arduino-cli.exe"
$cfg.paths.workspaceRoot="$slot/tmp/CK_Builds/v9/sessions";$cfg.paths.evidenceRoot="$slot/evidence"
$cfg|ConvertTo-Json -Depth 20|Set-Content "$slot/config.json" -Encoding utf8NoBOM
$env:CK_AB_ROUTE='candidate';$env:CK_AB_NEW_EDITS='0';$env:CK_AB_REPEAT_COUNT='1';$env:CK_AB_HISTORY='0';$env:CK_AB_REDISCOVERY='0'
$env:CK_AB_BOARD='esp32:esp32:esp32s3';$env:CK_V91_DESKTOP_DATA_ROOT="$slot/desktop";$env:CK_V91_PROJECTS_ROOT="$slot/projects";$env:WEBVIEW2_USER_DATA_FOLDER="$slot/webview"
$listener=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0)
$listener.Start();$port=$listener.LocalEndpoint.Port;$listener.Stop()
& "$pkg/engine/scripts/Start-Preview.ps1" -EngineConfig "$slot/config.json" -PreviewExe "$pkg/desktop/CK-V9-Preview.exe" -CdpPort $port -Harness "$PSScriptRoot/../tests/desktop-cold-edit-repeat.mjs"
if($LASTEXITCODE){throw 'Long-path build failed'}
$report=Get-Content -Raw "$slot/evidence/timings.json"|ConvertFrom-Json
if($report.status -ne 'PASS' -or $report.rows.Count -ne 3 -or $report.version -ne $cfg.engineVersion){throw 'Missing build evidence'}
$longest=(Get-ChildItem "$slot/tmp" -Recurse -Filter '*.json' -File | Where-Object DirectoryName -Like '*\.commands' | ForEach-Object {$_.FullName.Length} | Measure-Object -Maximum).Maximum
if($longest -le 260){throw "Fixture did not exercise a long Ninja input: $longest"}
[pscustomobject]@{version=$report.version;longest=$longest;timings=$report.rows.ms}|ConvertTo-Json|Set-Content "$Output/result.json" -Encoding utf8NoBOM
