# Compare the shipped desktops and controllers, not two labels on a single engine.
# Run in pwsh with the two extracted CK installations and matching Core configs.
param(
 [Parameter(Mandatory)][string]$Baseline,
 [Parameter(Mandatory)][string]$Candidate,
 [Parameter(Mandatory)][string]$AvrConfig,
 [Parameter(Mandatory)][string]$EspConfig,
 [Parameter(Mandatory)][string]$Output,
 [ValidateRange(1,8)][int]$Rounds=2,
 [ValidateRange(0,20)][int]$Edits=2,
 [ValidateRange(1,10)][int]$Repeats=3,
 [switch]$RequireEditP95
)
$ErrorActionPreference='Stop'
if(Test-Path -LiteralPath $Output){throw 'Use a new evidence directory.'}
$out=(New-Item -ItemType Directory -Path $Output).FullName
$versions=@{}
$harness=(Resolve-Path "$PSScriptRoot/../tests/desktop-cold-edit-repeat.mjs").Path
$env:CK_AB_ROUTE='candidate';$env:CK_AB_NEW_EDITS="$Edits";$env:CK_AB_REPEAT_COUNT="$Repeats";$env:CK_AB_HISTORY='0';$env:CK_AB_REDISCOVERY='0';$env:CK_AB_EDIT_OFFSET='0';$env:CK_AB_COMPACT_EXPORTS='1'
$env:NO_PROXY='localhost,127.0.0.1'
for($round=1;$round -le $Rounds;$round++){
 $env:CK_AB_EDIT_OFFSET=[string](($round-1)*$Edits)
 foreach($family in 'avr','esp'){
  $target=if($family -eq 'avr'){'arduino:avr:uno'}else{'esp32:esp32:esp32s3'}
  $profile=if($family -eq 'avr'){$AvrConfig}else{$EspConfig}
  $order=if(($round%2 -eq 1) -eq ($family -eq 'avr')){@($Baseline,$Candidate)}else{@($Candidate,$Baseline)}
  foreach($install in $order){
   $pkg=(Resolve-Path -LiteralPath $install).Path
   $version=(& "$pkg/engine/runtime/node.exe" --input-type=module -e 'import {pathToFileURL} from "node:url"; console.log((await import(pathToFileURL(process.argv[1]))).ENGINE_VERSION)' "$pkg/engine/src/version.mjs")
   if($LASTEXITCODE -ne 0 -or $version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z]+\.[0-9]+)?$'){throw "Cannot identify package at $pkg"}
   $versions[$install]=$version
   if($Baseline -eq $Candidate -or ($versions.Count -eq 2 -and $versions[$Baseline] -eq $versions[$Candidate])){throw 'Use two different releases.'}
   $slot=Join-Path $out "$round-$family-$version"
   $evidence=(New-Item -ItemType Directory -Path "$slot/evidence" -Force).FullName
   $cfg=Get-Content -Raw -LiteralPath $profile|ConvertFrom-Json
   $cfg.engineVersion=$version;$cfg.paths.node="$pkg/engine/runtime/node.exe";$cfg.paths.ninja="$pkg/engine/runtime/ninja.exe";$cfg.paths.cli="$pkg/desktop/bin/arduino-cli.exe"
   $cfg.paths.workspaceRoot="$slot/tmp/CK_Builds/v9/sessions";$cfg.paths.evidenceRoot=$evidence
   $cfg|ConvertTo-Json -Depth 16|Set-Content "$slot/config.json" -Encoding utf8NoBOM
   $env:CK_AB_BOARD=$target;$env:CK_V91_DESKTOP_DATA_ROOT="$slot/desktop";$env:CK_V91_PROJECTS_ROOT="$slot/projects";$env:WEBVIEW2_USER_DATA_FOLDER="$slot/webview"
   $listener=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0)
   $listener.Start();$port=$listener.LocalEndpoint.Port;$listener.Stop()
   Write-Output "Starting round $round $target $version"
   & "$pkg/engine/scripts/Start-Preview.ps1" -EngineConfig "$slot/config.json" -PreviewExe "$pkg/desktop/CK-V9-Preview.exe" -CdpPort $port -Harness $harness
   $result=Get-Content "$evidence/timings.json" -Raw|ConvertFrom-Json
   $launch=Get-Content "$evidence/desktop-launch.json" -Raw|ConvertFrom-Json
   if($result.status -ne 'PASS' -or $result.version -ne $version -or $result.board -ne $target -or $launch.engineVersion -ne $version -or $result.rows.Count -ne (2+$Edits+$Repeats)){throw "Incomplete $slot"}
   # The harness checks each exported firmware before removal. Preserve JSON
   # evidence/config; reclaim only the build and WebView caches this run created.
   foreach($leaf in 'tmp','webview'){
    $dir=Get-Item -LiteralPath (Join-Path $slot $leaf) -ErrorAction SilentlyContinue
    if($dir -and $dir.Parent.FullName -eq $slot -and $dir.FullName.StartsWith($out+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -and !($dir.Attributes -band [IO.FileAttributes]::ReparsePoint)){
     try{Remove-Item -LiteralPath $dir.FullName -Recurse -Force -ErrorAction Stop}catch{Write-Warning "QA cache retained: $($dir.FullName)"}
    }
   }
  }
 }
}
$summaryArgs=@($out,$versions[$Baseline],$versions[$Candidate],$Rounds)
if($RequireEditP95){$summaryArgs+='--require-edit-p95'}
& "$Candidate/engine/runtime/node.exe" "$PSScriptRoot/../tests/release-button-comparison.mjs" @summaryArgs
if($LASTEXITCODE -eq 2){throw 'Edit-time P95 not qualified. See comparison.json for missing samples or threshold failures.'}
if($LASTEXITCODE -ne 0){throw 'Mismatched or incomplete release comparison.'}
