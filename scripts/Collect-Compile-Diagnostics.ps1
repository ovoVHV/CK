param(
    [string]$DataRoot = (Join-Path $env:LOCALAPPDATA 'CKBuildEngineV91'),
    [string]$BuildRoot = (Join-Path $env:LOCALAPPDATA 'CKV91\tmp\CK_Builds\v9'),
    [string]$OutputDirectory = ([Environment]::GetFolderPath('Desktop')),
    [ValidatePattern('^[-a-zA-Z0-9_]{0,100}$')][string]$RequestId = ''
)
$ErrorActionPreference = 'Stop'
$taskLocator = if($env:CK_STORAGE_LOCATOR){$env:CK_STORAGE_LOCATOR}else{Join-Path $env:LOCALAPPDATA 'CKBuildEngineV91\storage.json'}
if(Test-Path -LiteralPath $taskLocator){
    $taskStorage=Get-Content -LiteralPath $taskLocator -Raw -Encoding UTF8 | ConvertFrom-Json
    if($taskStorage.schema -ne 1){throw 'Unsupported CK storage configuration'}
    if(-not $PSBoundParameters.ContainsKey('DataRoot')){$DataRoot=$taskStorage.root}
    if(-not $PSBoundParameters.ContainsKey('BuildRoot')){$BuildRoot=Join-Path $taskStorage.temp 'CK_Builds\v9'}
}
# Read-only collection. Never launch the desktop, compiler, installer or a
# controller; never export source, binaries, bearer tokens or command lines.
$taskErrors = [Collections.Generic.List[string]]::new()
function Read-JsonFile([string]$File) {
    try {
        if (Test-Path -LiteralPath $File -PathType Leaf) {
            if ((Get-Item -LiteralPath $File).Length -gt 33554432) { throw 'Oversized diagnostic JSON' }
            return (Get-Content -LiteralPath $File -Raw -Encoding UTF8 | ConvertFrom-Json)
        }
    } catch { $taskErrors.Add("Cannot read $File") }
    return $null
}
function Pick-Fields($Value, [string[]]$Names) {
    $result = [ordered]@{}
    if ($null -ne $Value) {
        foreach ($name in $Names) {
            if ($null -ne $Value.PSObject.Properties[$name]) { $result[$name] = $Value.$name }
        }
    }
    return $result
}
function Child-Directories([string]$Folder, [int]$Limit) {
    if (Test-Path -LiteralPath $Folder -PathType Container) {
        Get-ChildItem -LiteralPath $Folder -Directory -ErrorAction SilentlyContinue |
            Where-Object { -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) } |
            Sort-Object LastWriteTimeUtc -Descending | Select-Object -First $Limit
    }
}
function Safe-Receipt($Receipt) {
    $safe = Pick-Fields $Receipt @('engineVersion','protocolVersion','cacheSchema','threatModel','requestId','sourceSha256','fqbn','sessionId','startedUnixMs','success','wallMs','phases','counts','graphReuse','sourceEligibility','officialReason','frontendMode','discoveryMode','ninjaInvocations','compilerInvoked','officialFrontendInvoked','generatedSha256','controller')
    $safe.noOpFastPath = Pick-Fields $Receipt.noOpFastPath @('hit','reason','elapsedMs')
    $safe.frontend = Pick-Fields $Receipt.frontend @('replayed','reason')
    $safe.prototypePreprocessReused = $Receipt.prototypePreprocessReused
    $safe.executionJobs = $Receipt.executionJobs
    $safe.coldDiscovery = Pick-Fields $Receipt.coldDiscovery @('sketchReadyMs','selectionReadyMs','completeMs')
    $safe.coldPipeline = Pick-Fields $Receipt.coldPipeline @('sketchStartedMs','sketchFinishedMs','queueMs','processMs','compiled','exitCode','invalidatedByFinalDiscovery')
    $safe.assetProof = Pick-Fields $Receipt.assetProof @('sha256','namespaceSha256','files','bytes','elapsedMs','nativeElapsedMs','mode','workers','openWorkers','maxOpenHandles','metrics')
    $safe.postAssetProof = Pick-Fields $Receipt.postAssetProof @('sha256','namespaceSha256','files','bytes','elapsedMs','nativeElapsedMs','mode','workers','openWorkers','maxOpenHandles','metrics')
    $safe.observation = Pick-Fields $Receipt.observation @('optimize','noop','reads','bytes','historyBytes','historyCapacityBytes')
    $safe.artifacts = @($Receipt.artifacts | ForEach-Object { Pick-Fields $_ @('name','bytes','sha256') })
    $safe.taskDecisions = @($Receipt.taskDecisions | ForEach-Object { Pick-Fields $_ @('task','decision','reason','actualWrites') })
    $safe.stageTimings = @($Receipt.stageTimings | ForEach-Object { Pick-Fields $_ @('rule','kind','elapsedMs','exitCode','mode') })
    $safe.batchTimings = @($Receipt.batchTimings | ForEach-Object { Pick-Fields $_ @('kinds','tasks','elapsedMs') })
    $safe.errorCode = $Receipt.error.code
    return $safe
}
$taskStamp = Get-Date -Format 'yyyyMMdd-HHmmss'
if (-not $OutputDirectory) { $OutputDirectory = $PSScriptRoot }
$taskOut = Join-Path $OutputDirectory ('CK-Compile-Diagnostics-' + $taskStamp + '-' + [Guid]::NewGuid().ToString('N').Substring(0,6))
New-Item -ItemType Directory -Path $taskOut -Force | Out-Null
$taskEnvironment = Read-JsonFile (Join-Path $DataRoot 'environment.json')
$taskLast = Read-JsonFile (Join-Path $DataRoot 'last-session.json')
$taskReport = [ordered]@{
    schemaVersion = 1
    collectedAt = (Get-Date).ToUniversalTime().ToString('o')
    purpose = 'Existing alpha.2+ build receipts only; no test build or installation performed'
    privacy = 'No source files, firmware bytes, CLI arguments, host tokens, WiFi passwords, or raw error logs are collected'
    environment = (Pick-Fields $taskEnvironment @('engineVersion','platform','arch','node','ninja','arduinoCli','core','sysroot','adminRequired'))
    lastSession = (Pick-Fields $taskLast @('session','engineVersion','desktopPid','fastEngineEnabled','coreReadyAtLaunch','initialization'))
    machine = [ordered]@{ processorCount = [Environment]::ProcessorCount; os = [Environment]::OSVersion.VersionString }
    sessions = @()
    requests = @()
    discoveryProcesses = @()
    requestedId = $RequestId
}
$taskComparison = Read-JsonFile (Join-Path $DataRoot 'cold-discovery-result.json')
if ($null -eq $taskComparison) { $taskComparison = Read-JsonFile (Join-Path $DataRoot 'wifi-wait-result.json') }
if ($null -ne $taskComparison) {
    $taskReport.wifiComparison = [ordered]@{
        engineVersion = $taskComparison.engineVersion
        status = $taskComparison.status
        boundary = $taskComparison.boundary
        pairs = $taskComparison.pairs
        targets = @($taskComparison.targets | ForEach-Object {
            [ordered]@{
                fqbn = $_.fqbn
                status = $_.status
                runs = @($_.runs | ForEach-Object {
                    [ordered]@{
                        label = $_.label
                        success = $_.success
                        wallMs = $_.wallMs
                        worker = (Safe-Receipt $_.host.worker)
                    }
                })
            }
        })
    }
}
try {
    $taskReport.machine.cpu = @(Get-CimInstance Win32_Processor | Select-Object Name,NumberOfCores,NumberOfLogicalProcessors)
    $taskReport.machine.memoryBytes = (Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory
    $taskReport.machine.disks = @(Get-CimInstance Win32_DiskDrive | Select-Object Model,MediaType,InterfaceType,Size)
} catch { $taskErrors.Add('Hardware details unavailable; build receipts remain usable') }
foreach ($taskSession in @(Child-Directories (Join-Path $DataRoot 'sessions') 8)) {
    $taskConfig = Read-JsonFile (Join-Path $taskSession.FullName 'engine.json')
    $taskLife = Join-Path $taskSession.FullName 'evidence\lifecycle.jsonl'
    $taskEvents = @()
    if (Test-Path -LiteralPath $taskLife -PathType Leaf) {
        foreach ($taskLine in @(Get-Content -LiteralPath $taskLife -Encoding UTF8 -Tail 240)) {
            try { $taskEvents += Pick-Fields ($taskLine | ConvertFrom-Json) @('type','at','id','key','reason','code','drained') } catch { $taskErrors.Add('Partial lifecycle record skipped') }
        }
    }
    $taskReport.sessions += [ordered]@{
        name = $taskSession.Name
        config = (Pick-Fields $taskConfig @('engineVersion','features','limits','assetValidation'))
        readiness = (Read-JsonFile (Join-Path $taskSession.FullName 'evidence\readiness.json'))
        lifecycle = $taskEvents
        controllerMetrics = (Read-JsonFile (Join-Path $taskSession.FullName 'controller-metrics.json'))
    }
    if ($RequestId) {
        $taskDiscovery = Read-JsonFile (Join-Path $taskSession.FullName ('evidence\runs\' + $RequestId + '.discovery.json'))
        if ($null -ne $taskDiscovery) {
            # Compiler output and arguments can contain source text. Export
            # only process timing, outcome and the unit's filename.
            $taskReport.discoveryProcesses += [ordered]@{
                session = $taskSession.Name
                requestId = $RequestId
                timings = (Pick-Fields $taskDiscovery.timings @('sketchReadyMs','selectionReadyMs','completeMs'))
                probes = @($taskDiscovery.probes | ForEach-Object {
                    $taskSafeProbe = Pick-Fields $_ @('kind','role','pid','startedUnixMs','code','elapsedMs')
                    $taskSafeProbe.unitName = [IO.Path]::GetFileName([string]$_.unit)
                    $taskSafeProbe
                })
            }
        }
    }
}
foreach ($taskNamespace in @(Child-Directories $BuildRoot 8)) {
    foreach ($taskRequestDir in @(Child-Directories (Join-Path $taskNamespace.FullName 'requests') 15)) {
        if ($RequestId -and $taskRequestDir.Name -ne $RequestId) { continue }
        $taskHost = Read-JsonFile (Join-Path $taskRequestDir.FullName 'artifacts\sketch\native-graph-host-receipt.json')
        $taskWorker = $taskHost.worker
        if ($null -eq $taskWorker) { $taskWorker = Read-JsonFile (Join-Path $taskRequestDir.FullName 'native-graph-receipt.json') }
        $taskRequest = Read-JsonFile (Join-Path $taskRequestDir.FullName 'request.json')
        if ($null -eq $taskWorker -and $null -eq $taskRequest) { continue }
        $taskReport.requests += [ordered]@{
            desktopNamespace = $taskNamespace.Name
            requestId = $taskRequestDir.Name
            lastWriteUtc = $taskRequestDir.LastWriteTimeUtc.ToString('o')
            request = (Pick-Fields $taskRequest @('requestId','sourceSha256','fqbn','workspace','jobs','forceClean','buildSignature'))
            host = (Pick-Fields $taskHost @('backend','requestId','sourceSha256','fqbn','buildSignature','toolchainKey','endToEndMs','adapterPhases'))
            worker = (Safe-Receipt $taskWorker)
        }
    }
}
$taskReport.errors = @($taskErrors.ToArray())
$taskReport | ConvertTo-Json -Depth 35 | Set-Content -LiteralPath (Join-Path $taskOut 'diagnostics.json') -Encoding UTF8
$taskLines = [Collections.Generic.List[string]]::new()
$taskLines.Add('CK compile diagnostics - existing receipts, no builds executed')
$taskLines.Add('Rows are individual requests; missing values are unknown, not zero.')
$taskLines.Add('Execution includes receipt observation; process times may overlap. Do not add every phase together.')
$taskLines.Add('')
foreach ($taskRow in $taskReport.requests) {
    $w = $taskRow.worker; $p = $w.phases; $c = $w.counts
    $taskLines.Add(('Request {0} | {1} | session {2}' -f $taskRow.requestId,$w.fqbn,$taskRow.desktopNamespace))
    $taskLines.Add(('  Host ms={0}; worker ms={1}; graph={2}; noop={3}' -f $taskRow.host.endToEndMs,$w.wallMs,$w.graphReuse.reason,$w.noOpFastPath.hit))
    $taskLines.Add(('  Discovery={0}; Prototype={1}; Compile={2}; Link={3}; Image={4}; objects retained={5}; restored={6}' -f $c.DiscoveryGCC,$c.PrototypeGCC,$c.CompileGCC,$c.Linker,$c.ImageGenerator,$c.ObjectRetained,$c.ObjectRestored))
    $taskLines.Add(('  ms: input={0}; properties={1}; discovery={2}; prototype={3}; execute={4}; observation={5}; post={6}; noop-check={7}; official-frontend={8}' -f $p.inputValidationMs,$p.propertiesMs,$p.discoveryMs,$p.prototypeMs,$p.executeMs,$p.ruleObservationMs,$p.postValidationMs,$p.noOpOutputValidationMs,$p.officialFrontendMs))
    foreach ($taskProofName in @('assetProof','postAssetProof')) {
        $taskProof = $w[$taskProofName]; $taskMetrics = $taskProof.metrics
        $taskLines.Add(('  {0}: wall ms={1}; native ms={2}; enumeration wall ms={3}; worker SUM ms: open={4}, read={5}, hash={6}, metadata={7}, close={8}' -f $taskProofName,$taskProof.elapsedMs,$taskProof.nativeElapsedMs,$taskMetrics.enumerationMs,$taskMetrics.openSumMs,$taskMetrics.readSumMs,$taskMetrics.hashSumMs,$taskMetrics.metadataSumMs,$taskMetrics.closeSumMs))
    }
}
foreach ($taskDiscovery in $taskReport.discoveryProcesses) {
    $taskLines.Add(('Discovery processes for {0}: SUM times overlap, not end-to-end wall time.' -f $taskDiscovery.requestId))
    foreach ($taskProbe in @($taskDiscovery.probes | Sort-Object { [double]$_.elapsedMs } -Descending | Select-Object -First 12)) {
        $taskLines.Add(('  {0} {1} {2}: {3} ms, exit={4}' -f $taskProbe.kind,$taskProbe.role,$taskProbe.unitName,$taskProbe.elapsedMs,$taskProbe.code))
    }
}
if ($taskReport.requests.Count -eq 0) { $taskLines.Add('No receipts found. Please return this package anyway; the location/environment details help diagnose this.') }
$taskLines.ToArray() | Set-Content -LiteralPath (Join-Path $taskOut 'summary.txt') -Encoding UTF8
$taskZip = $taskOut + '.zip'
Compress-Archive -LiteralPath $taskOut -DestinationPath $taskZip -CompressionLevel Optimal
Write-Host ''
Write-Host 'Collected existing build records. No installation, compilation or cache changes.'
Write-Host ('ZIP: ' + $taskZip)
Write-Host ('Requests: ' + $taskReport.requests.Count)
