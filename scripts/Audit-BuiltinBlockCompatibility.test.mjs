import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, '..');
const catalogPath = join(root, 'docs', 'compatibility', 'builtin-block-compatibility.json');
const auditPath = join(scriptDir, 'Audit-BuiltinBlockCompatibility.mjs');

const assertPublishedReportIsPrivate = raw => {
    assert.doesNotMatch(raw, /[A-Za-z]:[\\/]/, 'report must not contain a drive-qualified absolute path');
    assert.doesNotMatch(raw, /\\\\[^\\\s]+[\\]/, 'report must not contain a UNC path');
    assert.doesNotMatch(raw, /\bfile:\/\//i, 'report must not contain a file URI');
    assert.doesNotMatch(raw, /\b(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b/i, 'report must not contain a full MAC');
    assert.doesNotMatch(raw, /\b[0-9a-f]{4}(?:\.[0-9a-f]{4}){2}\b/i, 'report must not contain a dotted full MAC');
    assert.doesNotMatch(raw, /\bmac(?:\s+address)?\s*[:=]\s*[0-9a-f]{12}\b/i, 'report must not contain a bare full MAC');
};

test('compatibility catalog is explicit about evidence and architecture boundaries', async () => {
    const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
    assert.equal(catalog.schema, 'ck-builtin-block-compatibility');
    assert.equal(catalog.version, 1);
    assert.equal(catalog.claims.hardwareTested, false);
    assert.match(catalog.claims.generatorSmoke, /not a compile or hardware claim/i);
    assert.match(catalog.claims.compileOnly, /Only blocks named/i);
    assert.equal(catalog.blocks.length, 147);
    assert.equal(new Set(catalog.blocks).size, catalog.blocks.length);

    const byClass = new Map(catalog.architectureRules.map(rule => [rule.classification, rule]));
    assert.deepEqual(byClass.get('esp-wifi-family').unsupportedTargets, ['avr-nano']);
    assert.deepEqual(byClass.get('esp32-c5-c6-wifi6').types, ['wifi_set_protocol']);
    assert.deepEqual(byClass.get('esp32-uart-pins').types, ['serial_setup_with_pins']);
    assert.deepEqual(
        catalog.representativeCompileSuites.map(suite => suite.id),
        ['portable-core', 'esp32-network', 'portable-functions', 'portable-timing-io'],
    );
});

test('every built-in toolbox block generates on both audit contexts without catalog drift', async () => {
    await mkdir(join(root, 'tmp'), { recursive: true });
    const tempRoot = await mkdtemp(join(root, 'tmp', 'ck-builtin-block-audit-test-'));
    const reportPath = join(tempRoot, 'audit.json');
    const fixtureRoot = join(tempRoot, 'fixtures');
    try {
        const run = spawnSync(
            process.execPath,
            [auditPath, '--out', reportPath, '--emit-fixtures', fixtureRoot],
            { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
        );
        assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
        const reportRaw = await readFile(reportPath, 'utf8');
        assertPublishedReportIsPrivate(reportRaw);
        const report = JSON.parse(reportRaw);
        assert.equal(report.counts.toolboxTypes, 147);
        assert.equal(report.counts.staticToolboxTypes, 139);
        assert.equal(report.counts.dynamicToolboxTypes, 8);
        assert.ok(report.counts.registeredGeneratorTypes >= 147);
        assert.ok(report.counts.staticGeneratorReferences >= 147);
        assert.equal(report.counts.targetRuns, 294);
        assert.equal(report.counts.passed, 294);
        assert.equal(report.counts.failed, 0);
        assert.equal(report.hardwareTested, false);
        assert.ok(report.results.every(result => result.status === 'pass'));

        const resultFor = (target, type) => report.results.find(
            result => result.target === target && result.type === type,
        );
        assert.equal(resultFor('avr-nano', 'serial_print').status, 'pass');
        assert.equal(resultFor('avr-nano', 'wifi_connect').architectureAvailability, 'unsupported');
        assert.equal(resultFor('avr-nano', 'wifi_connect').compileEvidence, 'not-applicable');
        assert.equal(resultFor('esp32-c6', 'wifi_connect').architectureAvailability, 'supported');
        assert.deepEqual(
            resultFor('esp32-c6', 'wifi_set_protocol').compileOnlySuites,
            ['esp32-network'],
        );
        assert.deepEqual(
            resultFor('avr-nano', 'array_declare_3d_custom').compileOnlySuites,
            [],
            'static generation must not be promoted to compile evidence',
        );
        assert.equal(
            resultFor('avr-nano', 'array_declare_3d_custom').compileEvidence,
            'no-compile-evidence',
        );

        assert.equal(report.fixtures.length, 7);
        assert.ok(report.fixtures.every(fixture => fixture.hardwareTested === false));
        assert.ok(report.fixtures.every(fixture => !isAbsolute(fixture.directory)));
        assert.ok(report.fixtures.every(fixture => !isAbsolute(fixture.sketchPath)));
        assert.ok(report.fixtures.every(fixture => !fixture.directory.includes('\\')));
        assert.ok(report.fixtures.every(fixture => !fixture.sketchPath.includes('\\')));
        assert.ok(report.fixtures.every(fixture => fixture.directory.startsWith('tmp/ck-builtin-block-audit-test-')));
        assert.ok(report.fixtures.every(fixture => fixture.sketchPath.startsWith(`${fixture.directory}/`)));
        const portableAvr = report.fixtures.find(
            fixture => fixture.suite === 'portable-core' && fixture.target === 'avr-nano',
        );
        const networkC6 = report.fixtures.find(fixture => fixture.suite === 'esp32-network');
        const functionsAvr = report.fixtures.find(
            fixture => fixture.suite === 'portable-functions' && fixture.target === 'avr-nano',
        );
        const timingC6 = report.fixtures.find(
            fixture => fixture.suite === 'portable-timing-io' && fixture.target === 'esp32-c6',
        );
        const portableCode = await readFile(join(root, portableAvr.sketchPath), 'utf8');
        const networkCode = await readFile(join(root, networkC6.sketchPath), 'utf8');
        const functionsCode = await readFile(join(root, functionsAvr.sketchPath), 'utf8');
        const timingCode = await readFile(join(root, timingC6.sketchPath), 'utf8');
        assert.match(portableCode, /digitalWrite\(13, HIGH\)/);
        assert.match(portableCode, /Serial\.println\(analogRead\(0\)\)/);
        assert.match(networkCode, /Serial1\.begin\(115200, SERIAL_8N1, 19, 18\)/);
        assert.match(networkCode, /esp_wifi_set_protocol\(WIFI_IF_STA, WIFI_PROTOCOL_11AX\)/);
        assert.match(functionsCode, /void myFunction\(\)/);
        assert.match(functionsCode, /int myValue\(\)/);
        assert.match(functionsCode, /Serial\.println\(myValue\(\)\)/);
        assert.match(timingCode, /pulseInLong\(2, HIGH, 1000\)/);
        assert.match(timingCode, /attachInterrupt\(digitalPinToInterrupt\(2\)/);
        assert.match(timingCode, /namespace MsTimer2/);
    } finally {
        await rm(tempRoot, { recursive: true, force: true });
    }
});

test('fixture emission rejects an external root without disclosing that path', async () => {
    await mkdir(join(root, 'tmp'), { recursive: true });
    const reportRoot = await mkdtemp(join(root, 'tmp', 'ck-builtin-block-audit-reject-'));
    const externalRoot = await mkdtemp(join(tmpdir(), 'ck-builtin-block-audit-external-'));
    try {
        const run = spawnSync(
            process.execPath,
            [auditPath, '--out', join(reportRoot, 'audit.json'), '--emit-fixtures', externalRoot],
            { cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024 },
        );
        assert.notEqual(run.status, 0);
        assert.match(`${run.stdout}\n${run.stderr}`, /Fixture output must stay inside the CK root/);
        assert.doesNotMatch(`${run.stdout}\n${run.stderr}`, new RegExp(externalRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    } finally {
        await Promise.all([
            rm(reportRoot, { recursive: true, force: true }),
            rm(externalRoot, { recursive: true, force: true }),
        ]);
    }
});

test('DCE and core scripts label compile-only evidence without hardware claims', async () => {
    const [generateDce, runDce, coreCompatibility] = await Promise.all([
        readFile(join(scriptDir, 'generate_dce_suite.ps1'), 'utf8'),
        readFile(join(scriptDir, 'run_dce_suite.ps1'), 'utf8'),
        readFile(join(scriptDir, 'Test-CoreCompatibility.ps1'), 'utf8'),
    ]);
    assert.match(generateDce, /evidence = "compile-only-stress"/);
    assert.match(generateDce, /builtinBlockGeneratorCoverage = \$false/);
    assert.match(generateDce, /hardwareTested = \$false/);
    assert.match(runDce, /builtin_block_generator_coverage=false/);
    assert.match(runDce, /hardware_tested=false/);
    assert.match(coreCompatibility, /Evidence = 'compile-only'/);
    assert.match(coreCompatibility, /HardwareTested = \$false/);
    assert.match(coreCompatibility, /hardware_tested=false/);
    assert.match(coreCompatibility, /Resolve-RootContainedRelativePath -RootPath \$Root -RelativePath/);
    assert.match(coreCompatibility, /Join-Path \$rootFull \$RelativePath/);
    assert.match(coreCompatibility, /path = Get-RootRelativeEvidencePath -RootPath \$Root -Path \$auditFile/);
    assert.match(coreCompatibility, /\.Replace\('\\', '\/'\)/);
    assert.match(coreCompatibility, /Assert-PublishedCompatibilityReportPrivacy -Json \$serializedDocument/);
    assert.doesNotMatch(coreCompatibility, /generatorAudit = \[ordered\]@\{\s*path = \$auditFile/);
});
