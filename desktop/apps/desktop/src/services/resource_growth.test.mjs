import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('./resource_growth.ts', import.meta.url), 'utf8');
const transpiled = ts.transpileModule(source, {
    compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2020,
    },
    fileName: 'resource_growth.ts',
    reportDiagnostics: true,
});
assert.deepEqual(
    (transpiled.diagnostics || []).filter(item => item.category === ts.DiagnosticCategory.Error),
    [],
);

const { explainResourceGrowth, createResourceGrowthEvidenceFromLinkerMaps } = await import(
    `data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString('base64')}`
);

const report = {
    fqbn: 'esp32:esp32:esp32c6:FlashSize=16M',
    recordedAt: '2026-07-16T00:00:00Z',
    flash: { deltaBytes: 12000, deltaPercentagePoints: 1, baselineCapacityChanged: false },
    ram: { deltaBytes: 200, deltaPercentagePoints: 0.1, baselineCapacityChanged: false },
};

test('does not guess a library or block when only compiler totals exist', () => {
    const explanation = explainResourceGrowth(report);
    assert.equal(explanation.status, 'total-only');
    assert.equal(explanation.flashDeltaBytes, 12000);
    assert.equal(explanation.ramDeltaBytes, 200);
    assert.deepEqual(explanation.contributions, []);
    assert.match(explanation.detail, /不能精确归因/);
});

test('accepts content-addressed linker evidence only when exact sums reconcile', () => {
    const explanation = explainResourceGrowth(report, {
        schemaVersion: 1,
        fqbn: report.fqbn,
        recordedAt: '2026-07-16T00:01:00Z',
        currentMapSha256: 'a'.repeat(64),
        baselineMapSha256: 'c'.repeat(64),
        contributions: [
            {
                id: 'oled',
                label: 'OLED 库',
                kind: 'library',
                flashDeltaBytes: 9000,
                ramDeltaBytes: 180,
                evidence: {
                    kind: 'gnu-linker-map',
                    locator: 'firmware.map::liboled.a',
                    sha256: 'a'.repeat(64),
                    baselineSha256: 'c'.repeat(64),
                },
            },
            {
                id: 'sketch',
                label: '生成代码',
                kind: 'generated-code',
                flashDeltaBytes: 3000,
                ramDeltaBytes: 20,
                evidence: {
                    kind: 'gnu-linker-map',
                    locator: 'firmware.map::sketch.cpp.o',
                    sha256: 'a'.repeat(64),
                    baselineSha256: 'c'.repeat(64),
                },
            },
        ],
    });
    assert.equal(explanation.status, 'verified');
    assert.equal(explanation.contributions.length, 2);
    assert.equal(explanation.contributions[0].label, 'OLED 库');
});

test('rejects approximate or unbound attribution instead of displaying it', () => {
    const mismatch = explainResourceGrowth(report, {
        schemaVersion: 1,
        fqbn: report.fqbn,
        recordedAt: '2026-07-16T00:01:00Z',
        currentMapSha256: 'b'.repeat(64),
        baselineMapSha256: 'c'.repeat(64),
        contributions: [{
            id: 'guess',
            label: '某个库',
            kind: 'library',
            flashDeltaBytes: 11999,
            ramDeltaBytes: 200,
            evidence: {
                kind: 'gnu-linker-map',
                locator: 'firmware.map::lib.a',
                sha256: 'b'.repeat(64),
                baselineSha256: 'c'.repeat(64),
            },
        }],
    });
    assert.equal(mismatch.status, 'rejected');
    assert.deepEqual(mismatch.contributions, []);
    assert.match(mismatch.detail, /分摊之和与编译器总量不一致/);

    const wrongTarget = explainResourceGrowth(report, {
        schemaVersion: 1,
        fqbn: 'esp32:esp32:esp32s3',
        recordedAt: '2026-07-16T00:01:00Z',
        currentMapSha256: 'b'.repeat(64),
        baselineMapSha256: 'c'.repeat(64),
        contributions: [{
            id: 'guess',
            label: '某个库',
            kind: 'library',
            flashDeltaBytes: 12000,
            ramDeltaBytes: 200,
            evidence: {
                kind: 'gnu-linker-map',
                locator: 'firmware.map::lib.a',
                sha256: 'b'.repeat(64),
                baselineSha256: 'c'.repeat(64),
            },
        }],
    });
    assert.equal(wrongTarget.status, 'rejected');
    assert.match(wrongTarget.detail, /FQBN/);
});

test('never compares percentages after the configured capacity changes', () => {
    const explanation = explainResourceGrowth({
        ...report,
        flash: { ...report.flash, baselineCapacityChanged: true },
    });
    assert.equal(explanation.status, 'incomparable');
    assert.equal(explanation.flashDeltaBytes, null);
});

test('derives exact library deltas from two map summaries and keeps residual overhead explicit', () => {
    const fqbn = report.fqbn;
    const summary = (sha, programOutputBytes, ramOutputBytes, groups) => ({
        schemaVersion: 1,
        fqbn,
        classifierId: 'esp32-arduino-size-recipe-v2',
        recordedAt: '2026-07-16T00:01:00Z',
        mapFileName: 'firmware.ino.map',
        mapSha256: sha.repeat(64),
        mapBytes: 1000,
        programOutputBytes,
        ramOutputBytes,
        accountedProgramBytes: groups.reduce((sum, item) => sum + item.programBytes, 0),
        accountedRamBytes: groups.reduce((sum, item) => sum + item.ramBytes, 0),
        groups,
    });
    const baseline = summary('a', 100000, 10000, [{
        id: 'library:oled', label: 'OLED', kind: 'library', programBytes: 5000, ramBytes: 100,
    }]);
    const current = summary('b', 112000, 10200, [{
        id: 'library:oled', label: 'OLED', kind: 'library', programBytes: 16000, ramBytes: 250,
    }]);
    const fullReport = {
        ...report,
        flash: { ...report.flash, usedBytes: 112000 },
        ram: { ...report.ram, usedBytes: 10200 },
        linkerMapSummary: current,
        baselineLinkerMapSummary: baseline,
    };
    const evidence = createResourceGrowthEvidenceFromLinkerMaps(fullReport);
    assert.ok(evidence);
    assert.equal(evidence.currentMapSha256, 'b'.repeat(64));
    assert.equal(evidence.baselineMapSha256, 'a'.repeat(64));
    assert.equal(evidence.contributions.find(item => item.id === 'library:oled').flashDeltaBytes, 11000);
    const residual = evidence.contributions.find(item => item.id === 'linker-overhead-unassigned');
    assert.equal(residual.flashDeltaBytes, 1000);
    assert.equal(residual.ramDeltaBytes, 50);
    const explanation = explainResourceGrowth(fullReport, evidence);
    assert.equal(explanation.status, 'verified');
});

test('refuses map attribution when absolute section totals do not match compiler totals', () => {
    const bad = {
        ...report,
        flash: { ...report.flash, usedBytes: 112000 },
        ram: { ...report.ram, usedBytes: 10200 },
        linkerMapSummary: {
            fqbn: report.fqbn, programOutputBytes: 111999, ramOutputBytes: 10200,
            mapSha256: 'a'.repeat(64), mapFileName: 'x.map', recordedAt: '2026-07-16T00:00:00Z', groups: [],
        },
        baselineLinkerMapSummary: {
            fqbn: report.fqbn, programOutputBytes: 100000, ramOutputBytes: 10000,
            mapSha256: 'b'.repeat(64), mapFileName: 'x.map', recordedAt: '2026-07-16T00:00:00Z', groups: [],
        },
    };
    assert.equal(createResourceGrowthEvidenceFromLinkerMaps(bad), null);
});
