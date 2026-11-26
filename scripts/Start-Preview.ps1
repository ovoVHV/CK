param(
 [Parameter(Mandatory=$true)][string]$EngineConfig,
 [Parameter(Mandatory=$true)][string]$PreviewExe,
 [ValidateSet('v9','v6')][string]$Engine='v9',
 [string]$V6Exe,
 [string]$Harness,
 [int]$CdpPort=0
)
$ErrorActionPreference='Stop'
$taskRoot=Split-Path $PSScriptRoot -Parent
$taskConfig=Get-Content -LiteralPath $EngineConfig -Raw | ConvertFrom-Json
$taskEngineVersion=$taskConfig.engineVersion
$taskNode=$taskConfig.paths.node
$taskTemp=Split-Path (Split-Path (Split-Path $taskConfig.paths.workspaceRoot -Parent) -Parent) -Parent
$taskNames=@('TEMP','TMP','CK_V91_DATA_ROOT','CK_V9_CONFIG','CK_NATIVE_GRAPH_CONFIG','CK_LINUX_BACKEND_CONFIG','CK_FORGE_NATIVE_RELINK_QUALIFICATION_TOKEN','WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS','CK_V9_DESKTOP_PID','CK_V9_ENGINE_CONFIG','CK_CDP_LIST_URL')
$taskSaved=@{};foreach($taskName in $taskNames){$taskSaved[$taskName]=[Environment]::GetEnvironmentVariable($taskName,'Process')}
$taskApp=$null;$taskRunner=$null;$taskProfile=$null
try {
 foreach($taskName in @('CK_NATIVE_GRAPH_CONFIG','CK_LINUX_BACKEND_CONFIG','CK_V9_CONFIG')){[Environment]::SetEnvironmentVariable($taskName,$null,'Process')}
 if($Engine -eq 'v6'){
  if(-not $V6Exe){throw 'Explicit frozen v6 EXE required'}
  $taskFreeze=Get-Content -LiteralPath (Join-Path $taskRoot 'provenance\v8-g-freeze.json') -Raw | ConvertFrom-Json
  $taskExpected=($taskFreeze.productionBaseline | Where-Object {$_.File -like '*appsdesktop.exe'}).Expected
  if((Get-FileHash -LiteralPath $V6Exe -Algorithm SHA256).Hash.ToLowerInvariant() -ne $taskExpected){throw 'Frozen v6 hash differs'}
  Start-Process -FilePath $V6Exe -WorkingDirectory $taskConfig.paths.sysroot -WindowStyle Hidden
  return
 }
 if(-not (Test-Path -LiteralPath $PreviewExe)){throw 'Build the separate V9 preview EXE first'}
 New-Item -ItemType Directory -Path $taskTemp -Force | Out-Null
 $env:TEMP=$taskTemp;$env:TMP=$taskTemp
 $env:CK_V91_DATA_ROOT=$taskConfig.paths.sysroot
 $taskListener=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0);$taskListener.Start();$taskPort=$taskListener.LocalEndpoint.Port;$taskListener.Stop()
 $taskSession=& $taskNode -e 'const fs=require("node:fs"),path=require("node:path");process.stdout.write(fs.mkdtempSync(path.join(process.argv[1],"s")))' $taskTemp
 if($LASTEXITCODE -ne 0 -or !$taskSession){throw 'Could not allocate a new build directory'}
 # A new desktop session never clears or writes an old session's workspace,
 # even if its predecessor crashed before process-tree drain was observed.
 $env:TEMP=$taskSession;$env:TMP=$taskSession
 $taskConfig.paths.workspaceRoot=Join-Path $taskSession 'CK_Builds\v9\sessions'
 $taskSessionConfig=Join-Path $taskSession 'engine.json'
 $taskConfig | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $taskSessionConfig -Encoding utf8NoBOM
 $taskProfile=Join-Path $taskSession 'host.json'
 $taskToken=[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
 @{enabled=$true;engineVersion=$taskEngineVersion;protocolVersion=1;nodePath=$taskNode;enginePath=(Join-Path $taskRoot 'src\desktop-bridge.mjs');ninjaPath=$taskConfig.paths.ninja;allowedFqbns=$taskConfig.allowedFqbns;port=$taskPort;token=$taskToken} | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $taskProfile -Encoding utf8NoBOM
 $env:CK_V9_CONFIG=$taskProfile
 $env:CK_FORGE_NATIVE_RELINK_QUALIFICATION_TOKEN=[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
 if($CdpPort){$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=$CdpPort";$env:CK_CDP_LIST_URL="http://127.0.0.1:$CdpPort/json/list"}
 $taskApp=Start-Process -FilePath $PreviewExe -WorkingDirectory $taskConfig.paths.sysroot -WindowStyle Hidden -PassThru
 $env:CK_V9_DESKTOP_PID=[string]$taskApp.Id;$env:CK_V9_ENGINE_CONFIG=$taskSessionConfig
 $taskJob=Join-Path $taskSession 'server-job.json';$taskCancel=Join-Path $taskSession 'cancel';$taskInput=Join-Path $taskSession 'stdin.txt';[IO.File]::WriteAllText($taskInput,'')
 @{argv=@($taskNode,(Join-Path $taskRoot 'src\server.mjs'),'--config',$taskSessionConfig,'--profile',$taskProfile,'--desktop-pid',[string]$taskApp.Id);cwd=$taskRoot;owners=@($taskApp.Id);cancelFile=$taskCancel;metricsFile=(Join-Path $taskSession 'server-metrics.json')} | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $taskJob -Encoding utf8NoBOM
 $taskRunner=Start-Process -FilePath (Join-Path $taskRoot 'bin\job.exe') -ArgumentList ('"'+$taskJob+'"') -WorkingDirectory $taskRoot -WindowStyle Hidden -RedirectStandardInput $taskInput -RedirectStandardOutput (Join-Path $taskSession 'stdout.log') -RedirectStandardError (Join-Path $taskSession 'stderr.log') -PassThru
 $taskReady=$false
 for($taskI=0;$taskI -lt 120;$taskI++){
  $taskApp.Refresh();$taskRunner.Refresh();if($taskApp.HasExited -or $taskRunner.HasExited){throw "Preview or engine exited. See $taskSession"}
  try{$taskHealth=Invoke-RestMethod -Uri "http://127.0.0.1:$taskPort/health" -Headers @{Authorization="Bearer $taskToken"} -TimeoutSec 1;if($taskHealth.engineVersion -eq $taskEngineVersion){$taskReady=$true;break}}catch{}
  Start-Sleep -Milliseconds 250
 }
 if(-not $taskReady){throw 'V9 controller did not start'}
 @{processId=$taskApp.Id;exe=[IO.Path]::GetFullPath($PreviewExe);sha256=(Get-FileHash -LiteralPath $PreviewExe -Algorithm SHA256).Hash.ToLowerInvariant();session=$taskSession;engineVersion=$taskEngineVersion;elevated=([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $taskConfig.paths.evidenceRoot 'desktop-launch.json') -Encoding utf8NoBOM
 Copy-Item -LiteralPath (Join-Path $taskConfig.paths.evidenceRoot 'desktop-launch.json') -Destination (Join-Path $taskConfig.paths.evidenceRoot ("desktop-launch-"+$taskApp.Id+'.json'))
 if($Harness){& $taskNode $Harness;if($LASTEXITCODE -ne 0){throw 'V9 desktop harness failed; evidence retained'}}
 else {$taskApp.WaitForExit()}
} finally {
 if($taskApp){$taskApp.Refresh();if(-not $taskApp.HasExited){Stop-Process -Id $taskApp.Id -Force}}
 if($taskRunner){$taskRunner.Refresh();if(-not $taskRunner.HasExited){[IO.File]::WriteAllText($taskCancel,'cancel');if(-not $taskRunner.WaitForExit(15000)){Stop-Process -Id $taskRunner.Id -Force}}}
 if($taskProfile -and (Test-Path -LiteralPath $taskProfile)){[IO.File]::WriteAllText($taskProfile,'{"enabled":false}')}
 foreach($taskName in $taskNames){[Environment]::SetEnvironmentVariable($taskName,$taskSaved[$taskName],'Process')}
}
