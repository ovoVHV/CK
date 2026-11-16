import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const sourcePath = new URL('./compile_resources.ts', import.meta.url);
const dependencyOutput = source => ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const sourceMapUrl = `data:text/javascript;base64,${Buffer.from(dependencyOutput(await readFile(new URL('./compile_source_map.ts', import.meta.url), 'utf8'))).toString('base64')}`;
const projectIdentityUrl = `data:text/javascript;base64,${Buffer.from(dependencyOutput(await readFile(new URL('./project_identity.ts', import.meta.url), 'utf8'))).toString('base64')}`;
const source = (await readFile(sourcePath, 'utf8'))
    .replace("from './compile_source_map';", `from '${sourceMapUrl}';`)
    .replace("from './project_identity';", `from '${projectIdentityUrl}';`);
const workspaceSource = await readFile(new URL('../components/Workspace.tsx', import.meta.url), 'utf8');
const resourcePanelSource = await readFile(new URL('../components/ResourceBudgetPanel.tsx', import.meta.url), 'utf8');
const transpiled = ts.transpileModule(source, {
    compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2020,
    },
    fileName: 'compile_resources.ts',
    reportDiagnostics: true,
});

const syntaxErrors = (transpiled.diagnostics || []).filter(
    diagnostic => diagnostic.category === ts.DiagnosticCategory.Error,
);
assert.deepEqual(syntaxErrors, [], 'compile_resources.ts should transpile without syntax errors');

const resources = await import(
    `data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString('base64')}`
);

const {
    assessMemoryConfiguration,
    compileResourceSnapshotToReport,
    createCompileResourceReport,
    createCompileResourceSnapshot,
    formatResourceBytes,
    formatResourceDelta,
    isSameCompileResourceTarget,
    loadCompileResourceSnapshot,
    parseCompileMemoryConfiguration,
    parseCompileResourceUsage,
    parseLinkerMapResourceSummary,
    parseResolvedCompileFqbn,
    parseUploaderMemoryDetection,
    resourceBudgetLevel,
    saveCompileResourceSnapshot,
    selectCompileMemoryConfigurationFqbn,
} = resources;

const linkerMapSummary = (overrides = {}) => ({
    schemaVersion: 1,
    fqbn: 'esp32:esp32:esp32c6:FlashSize=16M',
    classifierId: 'esp32-arduino-size-recipe-v2',
    recordedAt: '2026-07-16T01:00:00Z',
    mapFileName: 'firmware.ino.map',
    mapSha256: 'a'.repeat(64),
    mapBytes: 12_000_000,
    programOutputBytes: 930582,
    ramOutputBytes: 39964,
    accountedProgramBytes: 100,
    accountedRamBytes: 20,
    groups: [{
        id: 'library:wifi', label: 'WiFi', kind: 'library', programBytes: 100, ramBytes: 20,
    }],
    ...overrides,
});

test('accepts hash-bound linker summaries and rejects malformed or wrong-target evidence', () => {
    const summary = linkerMapSummary();
    const log = `[CK_LINKER_MAP_SUMMARY] ${JSON.stringify(summary)}\n`;
    assert.deepEqual(parseLinkerMapResourceSummary(log, summary.fqbn), summary);
    assert.equal(parseLinkerMapResourceSummary(log, 'esp32:esp32:esp32s3'), null);
    assert.equal(parseLinkerMapResourceSummary(
        `[CK_LINKER_MAP_SUMMARY] ${JSON.stringify(linkerMapSummary({ mapSha256: 'bad' }))}`,
        summary.fqbn,
    ), null);
    assert.equal(parseLinkerMapResourceSummary(
        `[CK_LINKER_MAP_SUMMARY] ${JSON.stringify(linkerMapSummary({ accountedProgramBytes: 101 }))}`,
        summary.fqbn,
    ), null);
});

test('resource results only publish back to the exact project, FQBN, and compile session', () => {
    const started = {
        projectPath: 'C:/Projects/weather.maker',
        requestedFqbn: 'esp32:esp32:esp32s3:FlashSize=16M,PSRAM=opi',
        sessionId: 12,
        codeFingerprint: '100:abc',
        runId: 'run-12',
    };
    assert.equal(isSameCompileResourceTarget(started, { ...started }), true);
    assert.equal(isSameCompileResourceTarget(started, {
        ...started,
        requestedFqbn: 'esp32:esp32:esp32s3:FlashSize=8M,PSRAM=opi',
    }), false, 'an old N16 result must not overwrite an N8 resource panel');
    assert.equal(isSameCompileResourceTarget(started, {
        ...started,
        projectPath: 'C:/Projects/other.maker',
    }), false);
    assert.equal(isSameCompileResourceTarget(started, { ...started, sessionId: 13 }), false);
    assert.equal(isSameCompileResourceTarget(started, { ...started, codeFingerprint: '101:def' }), false);
    assert.equal(isSameCompileResourceTarget(started, { ...started, runId: 'run-13' }), false);
});

const standardLog = `
Sketch uses 969252 bytes (73%) of program storage space. Maximum is 1310720 bytes.
Global variables use 46456 bytes (14%) of dynamic memory, leaving 281224 bytes for local variables. Maximum is 327680 bytes.
`;

test('parses Arduino Flash and RAM summaries using exact byte ratios', () => {
    const usage = parseCompileResourceUsage(standardLog);
    assert.ok(usage);
    assert.equal(usage.flash.usedBytes, 969252);
    assert.equal(usage.flash.totalBytes, 1310720);
    assert.equal(usage.flash.freeBytes, 341468);
    assert.equal(usage.flash.reportedPercent, 73);
    assert.ok(Math.abs(usage.flash.percent - 73.94805908203125) < 0.000001);
    assert.equal(usage.flash.level, 'normal');

    assert.equal(usage.ram.usedBytes, 46456);
    assert.equal(usage.ram.totalBytes, 327680);
    assert.equal(usage.ram.freeBytes, 281224);
    assert.ok(Math.abs(usage.ram.percent - 14.17724609375) < 0.000001);
});

test('keeps ESP8266 used bytes without inventing a program capacity', () => {
    const usage = parseCompileResourceUsage(`
. Variables and constants in RAM (global, static), used 28088 / 80192 bytes (35%)
|   SEGMENT  BYTES    DESCRIPTION
|-- DATA     1500     initialized variables
|-- RODATA   908      constants
\`-- BSS      25680    zeroed variables
. Instruction RAM (IRAM_ATTR, ICACHE_RAM_ATTR), used 59985 / 65536 bytes (91%)
|   SEGMENT  BYTES    DESCRIPTION
|-- ICACHE   32768    reserved space for flash instruction cache
\`-- IRAM     27217    code in IRAM
. Code in flash (default, ICACHE_FLASH_ATTR), used 237944 / 1048576 bytes (22%)
|   SEGMENT  BYTES    DESCRIPTION
\`-- IROM     237944   code in flash
`);

    assert.ok(usage);
    assert.equal(usage.flash.usedBytes, 267569);
    assert.equal(usage.flash.capacityKnown, false);
    assert.equal(usage.flash.totalBytes, 0);
    assert.equal(usage.ram.usedBytes, 28088);
    assert.equal(usage.ram.capacityKnown, false);
    assert.match(resourcePanelSource, /t\('resource\.coreCapacityUnknown'\)/);
});

test('rejects incomplete ESP8266 segment evidence instead of reporting IROM as total Flash', () => {
    const usage = parseCompileResourceUsage(`
. Variables and constants in RAM (global, static), used 28088 / 80192 bytes (35%)
. Code in flash (default, ICACHE_FLASH_ATTR), used 237944 / 1048576 bytes (22%)
`);

    assert.ok(usage);
    assert.equal(usage.flash, null);
    assert.equal(usage.ram.usedBytes, 28088);
});

test('uses the final valid summary after an upload fallback and ignores ANSI colour', () => {
    const usage = parseCompileResourceUsage(`
\u001b[32mSketch uses 100 bytes (10%) of program storage space. Maximum is 1000 bytes.\u001b[0m
Global variables use 20 bytes (2%) of dynamic memory, leaving 980 bytes for local variables. Maximum is 1000 bytes.
Sketch uses 850 bytes (85%) of program storage space. Maximum is 1000 bytes.
Global variables use 910 bytes (91%) of dynamic memory, leaving 90 bytes for local variables. Maximum is 1000 bytes.
`);
    assert.equal(usage.flash.usedBytes, 850);
    assert.equal(usage.flash.level, 'warning');
    assert.equal(usage.ram.usedBytes, 910);
    assert.equal(usage.ram.level, 'critical');
});

test('parses uploader-observed ESP32 Flash and PSRAM only when explicitly requested', () => {
    const measuredAt = '2026-07-12T02:03:04.000Z';
    const uploadLog = `
Chip type: ESP32-S3 (QFN56) (revision v0.2)
Features: Wi-Fi, BLE, Embedded PSRAM 8MB (AP_3v3)
Flash size: 16MB
${standardLog}
`;
    assert.deepEqual(parseUploaderMemoryDetection(uploadLog, measuredAt), {
        flashBytes: 16 * 1024 * 1024,
        psramBytes: 8 * 1024 * 1024,
        source: 'uploader-log',
        measuredAt,
    });

    const compileOnly = parseCompileResourceUsage(uploadLog);
    assert.equal(compileOnly.uploaderMemory, null, 'compile logs must not claim a hardware measurement');

    const upload = parseCompileResourceUsage(uploadLog, {
        includeUploaderMemory: true,
        uploaderMeasuredAt: measuredAt,
    });
    assert.equal(upload.uploaderMemory.flashBytes, 16 * 1024 * 1024);
    assert.equal(upload.uploaderMemory.psramBytes, 8 * 1024 * 1024);
    assert.equal(upload.uploaderMemory.measuredAt, measuredAt);
});

test('does not mistake prefixed configuration text for uploader-observed memory', () => {
    const noisyLog = `
[INFO] Flash size: 4MB
Board config Flash size: 8MB
compiler note: Embedded PSRAM 16MB
PSRAM size: 8MB
--flash-size 4MB
`;
    assert.equal(parseUploaderMemoryDetection(noisyLog), null);
    const measuredAt = '2026-07-12T03:04:05.000Z';
    assert.deepEqual(parseUploaderMemoryDetection(`
Detected flash size: 16MB
Features: Wi-Fi, BLE, Embedded PSRAM 8MB (AP_3v3)
`, measuredAt), {
        flashBytes: 16 * 1024 * 1024,
        psramBytes: 8 * 1024 * 1024,
        source: 'uploader-log',
        measuredAt,
    });
});

test('compile-only results preserve the original uploader measurement time for the same target', () => {
    const fqbn = 'esp32:esp32:esp32s3:FlashSize=16M,PSRAM=opi';
    const firstMeasuredAt = '2026-07-11T01:02:03.000Z';
    const compileCapturedAt = '2026-07-12T04:05:06.000Z';
    const uploadUsage = parseCompileResourceUsage(`
Flash size: 16MB
Features: Wi-Fi, BLE, Embedded PSRAM 8MB (AP_3v3)
${standardLog}
`, { includeUploaderMemory: true, uploaderMeasuredAt: firstMeasuredAt });
    const previous = createCompileResourceSnapshot(fqbn, uploadUsage, firstMeasuredAt, fqbn);
    const compileOnlyUsage = parseCompileResourceUsage(standardLog);
    const compileReport = createCompileResourceReport(
        compileOnlyUsage,
        previous,
        compileCapturedAt,
        fqbn,
    );

    assert.equal(compileReport.recordedAt, compileCapturedAt);
    assert.equal(compileReport.uploaderMemory.measuredAt, firstMeasuredAt);
    const compileSnapshot = createCompileResourceSnapshot(
        fqbn,
        { ...compileOnlyUsage, uploaderMemory: compileReport.uploaderMemory },
        compileCapturedAt,
        fqbn,
    );
    assert.equal(compileSnapshot.capturedAt, compileCapturedAt);
    assert.equal(compileSnapshot.uploaderMemory.measuredAt, firstMeasuredAt);

    const nextMeasuredAt = '2026-07-12T07:08:09.000Z';
    const nextUploadUsage = parseCompileResourceUsage(`Flash size: 16MB\n${standardLog}`, {
        includeUploaderMemory: true,
        uploaderMeasuredAt: nextMeasuredAt,
    });
    const nextUploadReport = createCompileResourceReport(
        nextUploadUsage,
        previous,
        nextMeasuredAt,
        fqbn,
    );
    assert.equal(nextUploadReport.uploaderMemory.measuredAt, nextMeasuredAt);
});

test('workspace snapshots and the resource panel use measuredAt instead of a later compile time', () => {
    assert.match(workspaceSource, /uploaderMeasuredAt: capturedAt/);
    assert.match(workspaceSource, /\{ \.\.\.usage, uploaderMemory: report\.uploaderMemory \}/);
    assert.match(resourcePanelSource, /report\.uploaderMemory\?\.measuredAt/);
    assert.doesNotMatch(resourcePanelSource, /report\.uploaderMemory && report\.recordedAt/);
});

test('assesses only deterministic differences between configured and observed memory', () => {
    const observed = {
        flashBytes: 16 * 1024 * 1024,
        psramBytes: 8 * 1024 * 1024,
        source: 'uploader-log',
    };
    assert.deepEqual(assessMemoryConfiguration({
        flashSizeOption: '4M',
        psramOption: 'disabled',
        partitionSchemeOption: 'default',
    }, observed), {
        flash: 'configured-smaller',
        psramDisabledButPresent: true,
    });
    assert.equal(assessMemoryConfiguration({
        flashSizeOption: '32M',
        psramOption: 'opi',
        partitionSchemeOption: 'default',
    }, observed).flash, 'configured-larger');
    assert.equal(assessMemoryConfiguration({
        flashSizeOption: '16M',
        psramOption: 'opi',
        partitionSchemeOption: 'default',
    }, observed).flash, 'match');
    assert.equal(assessMemoryConfiguration({
        flashSizeOption: null,
        psramOption: 'opi',
        partitionSchemeOption: null,
    }, observed).flash, 'unknown');
});

test('uses the final backend-resolved target FQBN after retries', () => {
    assert.equal(parseResolvedCompileFqbn(`
[INFO] Target Board: esp32:esp32:esp32s3:FlashSize=4M
[WARN] retry
[INFO] Target Board: esp32:esp32:esp32s3:FlashSize=16M,PSRAM=opi
`), 'esp32:esp32:esp32s3:FlashSize=16M,PSRAM=opi');
});

test('keeps FQBN configuration values separate and never guesses N/R module suffixes', () => {
    assert.deepEqual(
        parseCompileMemoryConfiguration(
            'esp32:esp32:esp32s3:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB,PSRAM=opi',
        ),
        {
            flashSizeOption: '16M',
            psramOption: 'opi',
            partitionSchemeOption: 'app3M_fat9M_16MB',
        },
    );
    assert.deepEqual(parseCompileMemoryConfiguration('vendor:esp32:module_n16r8'), {
        flashSizeOption: null,
        psramOption: null,
        partitionSchemeOption: null,
    });
});

test('uses the backend-resolved FQBN for a custom alias memory assessment while retaining alias traceability', () => {
    const aliasIdentity = 'my-s3-board:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB,PSRAM=opi';
    const resolvedIdentity = 'esp32:esp32:esp32s3:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB,PSRAM=opi';
    const assessmentIdentity = selectCompileMemoryConfigurationFqbn(aliasIdentity, resolvedIdentity);

    assert.equal(assessmentIdentity, resolvedIdentity);
    const configuration = parseCompileMemoryConfiguration(assessmentIdentity);
    assert.deepEqual(configuration, {
        flashSizeOption: '16M',
        psramOption: 'opi',
        partitionSchemeOption: 'app3M_fat9M_16MB',
    });
    assert.equal(assessMemoryConfiguration(configuration, {
        flashBytes: 8 * 1024 * 1024,
        psramBytes: 8 * 1024 * 1024,
        source: 'uploader-log',
        measuredAt: '2026-07-12T02:03:04.000Z',
    }).flash, 'configured-larger');
    assert.match(resourcePanelSource, /t\('resource\.configuration\.title'/);
    assert.match(resourcePanelSource, /configurationIdentity/);
    assert.match(resourcePanelSource, /resolvedFqbn/);
});

test('keeps standard display FQBN defaults for memory assessment', () => {
    const displayIdentity = 'esp32:esp32:esp32s3:FlashSize=4M,PartitionScheme=default,PSRAM=disabled';
    assert.equal(
        selectCompileMemoryConfigurationFqbn(displayIdentity, 'esp32:esp32:esp32s3'),
        displayIdentity,
    );
});

test('accepts boards that only report Flash and rejects unrelated output', () => {
    const flashOnly = parseCompileResourceUsage(
        'Sketch uses 32,768 bytes (80%) of program storage space. Maximum is 40,960 bytes.',
    );
    assert.equal(flashOnly.flash.usedBytes, 32768);
    assert.equal(flashOnly.flash.level, 'warning');
    assert.equal(flashOnly.ram, null);
    assert.equal(parseCompileResourceUsage('[INFO] Compile finished'), null);
});

test('uses 80% warning and 90% critical thresholds', () => {
    assert.equal(resourceBudgetLevel(79.999), 'normal');
    assert.equal(resourceBudgetLevel(80), 'warning');
    assert.equal(resourceBudgetLevel(89.999), 'warning');
    assert.equal(resourceBudgetLevel(90), 'critical');
});

test('compares current memory use with the previous successful snapshot', () => {
    const firstUsage = parseCompileResourceUsage(standardLog);
    const previous = createCompileResourceSnapshot('esp32:esp32:esp32c5', firstUsage, '2026-07-11T00:00:00.000Z');
    const current = parseCompileResourceUsage(`
Sketch uses 981540 bytes (74%) of program storage space. Maximum is 1310720 bytes.
Global variables use 49008 bytes (15%) of dynamic memory, leaving 278672 bytes for local variables. Maximum is 327680 bytes.
`);
    const report = createCompileResourceReport(current, previous, '2026-07-12T00:00:00.000Z');
    assert.equal(report.flash.deltaBytes, 12288);
    assert.ok(Math.abs(report.flash.deltaPercentagePoints - 0.9375) < 0.000001);
    assert.equal(report.ram.deltaBytes, 2552);
    assert.equal(report.recordedAt, '2026-07-12T00:00:00.000Z');

    const restored = compileResourceSnapshotToReport(previous);
    assert.equal(restored.flash.deltaBytes, null);
    assert.equal(restored.recordedAt, previous.capturedAt);
});

test('does not compare percentages when capacity changes under the same FQBN', () => {
    const fqbn = 'esp32:esp32:esp32s3:FlashSize=16M,PartitionScheme=custom,PSRAM=opi';
    const previous = createCompileResourceSnapshot(fqbn, parseCompileResourceUsage(`
Sketch uses 900000 bytes (68%) of program storage space. Maximum is 1310720 bytes.
Global variables use 50000 bytes (15%) of dynamic memory, leaving 277680 bytes for local variables. Maximum is 327680 bytes.
`));
    const current = parseCompileResourceUsage(`
Sketch uses 950000 bytes (30%) of program storage space. Maximum is 3145728 bytes.
Global variables use 52000 bytes (15%) of dynamic memory, leaving 275680 bytes for local variables. Maximum is 327680 bytes.
`);
    const report = createCompileResourceReport(current, previous);

    assert.equal(report.flash.baselineCapacityChanged, true);
    assert.equal(report.flash.deltaBytes, null);
    assert.equal(report.flash.deltaPercentagePoints, null);
    assert.equal(report.ram.baselineCapacityChanged, false);
    assert.equal(report.ram.deltaBytes, 2000);
    assert.equal(
        formatResourceDelta(
            report.flash.deltaBytes,
            report.flash.deltaPercentagePoints,
            report.flash.baselineCapacityChanged,
        ),
        '容量配置已变化，已重建基线',
    );
});

test('persists resource baselines per project and board', () => {
    const values = new Map();
    const storage = {
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value),
    };
    const usage = parseCompileResourceUsage(standardLog);
    const snapshot = createCompileResourceSnapshot('arduino:avr:nano', usage);

    assert.equal(saveCompileResourceSnapshot('C:\\Projects\\blink.maker', snapshot, storage), true);
    const loaded = loadCompileResourceSnapshot('C:\\Projects\\blink.maker', 'arduino:avr:nano', storage);
    assert.equal(loaded.fqbn, snapshot.fqbn);
    assert.equal(loaded.schemaVersion, 2);
    assert.match(loaded.projectIdentitySha256, /^[0-9a-f]{64}$/);
    assert.equal(
        loadCompileResourceSnapshot('C:\\Projects\\other.maker', 'arduino:avr:nano', storage),
        null,
    );
    assert.equal(
        loadCompileResourceSnapshot('C:\\Projects\\blink.maker', 'esp32:esp32:esp32', storage),
        null,
    );
});

test('stores a custom board alias separately while retaining backend-resolved identity', () => {
    const values = new Map();
    const storage = {
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value),
    };
    const snapshot = createCompileResourceSnapshot(
        'esp32:esp32:esp32s3:FlashSize=16M',
        parseCompileResourceUsage(standardLog),
        '2026-07-12T00:00:00.000Z',
        'my-s3-board:FlashSize=16M',
    );
    assert.equal(saveCompileResourceSnapshot('C:\\Projects\\alias.maker', snapshot, storage), true);
    const loaded = loadCompileResourceSnapshot(
        'C:\\Projects\\alias.maker',
        'my-s3-board:FlashSize=16M',
        storage,
    );
    assert.equal(loaded.fqbn, 'esp32:esp32:esp32s3:FlashSize=16M');
    assert.equal(loaded.requestedFqbn, 'my-s3-board:FlashSize=16M');
    assert.equal(
        loadCompileResourceSnapshot('C:\\Projects\\alias.maker', loaded.fqbn, storage),
        null,
    );
});

test('rejects an older v1 snapshot without an exact project identity', () => {
    const values = new Map();
    const storage = {
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value),
    };
    const fqbn = 'arduino:avr:nano';
    const seed = createCompileResourceSnapshot(fqbn, parseCompileResourceUsage(standardLog));
    assert.equal(saveCompileResourceSnapshot('C:\\Projects\\legacy.maker', seed, storage), true);
    const [key] = values.keys();
    values.set(key, JSON.stringify({
        schemaVersion: 1,
        fqbn,
        capturedAt: '2026-07-10T00:00:00.000Z',
        flash: {
            usedBytes: 900,
            totalBytes: 1000,
            reportedPercent: 90,
        },
        ram: null,
    }));

    assert.equal(loadCompileResourceSnapshot('C:\\Projects\\legacy.maker', fqbn, storage), null);
});

test('safely migrates legacy uploader measurements without inventing a new time', () => {
    const values = new Map();
    const storage = {
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value),
    };
    const fqbn = 'esp32:esp32:esp32s3:FlashSize=16M,PSRAM=opi';
    const projectPath = 'C:\\Projects\\legacy-measurement.maker';
    const legacyMeasuredAt = '2026-07-10T05:06:07.000Z';
    const seed = createCompileResourceSnapshot(fqbn, parseCompileResourceUsage(standardLog));
    assert.equal(saveCompileResourceSnapshot(projectPath, seed, storage), true);
    const [key] = values.keys();
    const legacy = {
        ...JSON.parse(values.get(key)),
        capturedAt: legacyMeasuredAt,
        uploaderMemory: {
            flashBytes: 16 * 1024 * 1024,
            psramBytes: 8 * 1024 * 1024,
            source: 'uploader-log',
        },
    };
    values.set(key, JSON.stringify(legacy));

    const migrated = loadCompileResourceSnapshot(projectPath, fqbn, storage);
    assert.equal(migrated.uploaderMemory.measuredAt, legacyMeasuredAt);

    values.set(key, JSON.stringify({
        ...legacy,
        uploaderMemory: { ...legacy.uploaderMemory, measuredAt: 'not-a-time' },
    }));
    const corruptedNewTimestamp = loadCompileResourceSnapshot(projectPath, fqbn, storage);
    assert.equal(corruptedNewTimestamp.uploaderMemory, null);
    assert.ok(corruptedNewTimestamp.flash, 'valid compile metrics remain usable');

    values.set(key, JSON.stringify({ ...legacy, capturedAt: 'not-a-time' }));
    const legacyWithoutSafeTime = loadCompileResourceSnapshot(projectPath, fqbn, storage);
    assert.equal(legacyWithoutSafeTime.uploaderMemory, null);
    assert.ok(legacyWithoutSafeTime.flash, 'unsafe legacy hardware time is dropped independently');
});

test('full SHA-256 identity separates paths that collide under the former 32-bit FNV key', () => {
    const values = new Map();
    const storage = {
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value),
    };
    const fqbn = 'arduino:avr:nano';
    const left = 'C:/Projects/1g6hhtmuhd.maker';
    const right = 'C:/Projects/1cbasd412cf.maker';
    const oldFnv = value => {
        let hash = 0x811c9dc5;
        for (const char of `${value.toLowerCase()}|${fqbn}`) {
            hash ^= char.charCodeAt(0);
            hash = Math.imul(hash, 0x01000193);
        }
        return hash >>> 0;
    };
    assert.equal(oldFnv(left), oldFnv(right), 'fixture must reproduce the former key collision');
    const leftUsage = parseCompileResourceUsage(standardLog);
    const rightUsage = parseCompileResourceUsage(standardLog.replace('969252', '900000'));
    saveCompileResourceSnapshot(left, createCompileResourceSnapshot(fqbn, leftUsage), storage);
    saveCompileResourceSnapshot(right, createCompileResourceSnapshot(fqbn, rightUsage), storage);
    assert.equal(values.size, 2);
    assert.equal(loadCompileResourceSnapshot(left, fqbn, storage).flash.usedBytes, 969252);
    assert.equal(loadCompileResourceSnapshot(right, fqbn, storage).flash.usedBytes, 900000);
});

test('ignores corrupted derived fields and rejects corrupted source measurements', () => {
    const values = new Map();
    const storage = {
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value),
    };
    const fqbn = 'esp32:esp32:esp32c5';
    const seed = createCompileResourceSnapshot(fqbn, parseCompileResourceUsage(standardLog));
    assert.equal(saveCompileResourceSnapshot('C:\\Projects\\damaged.maker', seed, storage), true);
    const [key] = values.keys();
    const damaged = JSON.parse(values.get(key));
    damaged.flash.freeBytes = -123;
    damaged.flash.percent = 1;
    damaged.flash.level = 'normal';
    damaged.ram.usedBytes = '46456';
    values.set(key, JSON.stringify(damaged));

    const loaded = loadCompileResourceSnapshot('C:\\Projects\\damaged.maker', fqbn, storage);
    assert.equal(loaded.flash.freeBytes, 341468);
    assert.ok(Math.abs(loaded.flash.percent - 73.94805908203125) < 0.000001);
    assert.equal(loaded.flash.level, 'normal');
    assert.equal(loaded.ram, null);

    damaged.flash.totalBytes = 0;
    values.set(key, JSON.stringify(damaged));
    assert.equal(
        loadCompileResourceSnapshot('C:\\Projects\\damaged.maker', fqbn, storage),
        null,
    );
});

test('formats byte values and signed previous-build deltas for the UI', () => {
    assert.equal(formatResourceBytes(900), '900 B');
    assert.equal(formatResourceBytes(12 * 1024), '12.0 KB');
    assert.equal(formatResourceBytes(1310720), '1.25 MB');
    assert.equal(formatResourceDelta(null, null), '暂无对比基线');
    assert.equal(formatResourceDelta(0, 0), '较上次无变化');
    assert.equal(formatResourceDelta(12288, 0.9375), '较上次 +12.0 KB（+0.9%）');
    assert.equal(formatResourceDelta(-1024, -0.5), '较上次 −1.0 KB（−0.5%）');
});
