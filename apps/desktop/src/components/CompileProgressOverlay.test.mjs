import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('./CompileProgressOverlay.tsx', import.meta.url), 'utf8');
const evidenceSource = fs.readFileSync(new URL('../services/project_acceptance_report.ts', import.meta.url), 'utf8');

test('determinate progress reserves an independent four-character percentage column', () => {
    assert.match(source, /data-ck-role="compile-progress-percentage"/);
    assert.match(source, /w-\[4\.5ch\]/);
    assert.match(source, /shrink-0/);
    assert.match(source, /tabular-nums/);
    assert.match(source, /formatBuildPercentage\(progress\.percentage\)/);
});

test('stage message and elapsed time no longer share the percentage text slot', () => {
    assert.match(source, /data-ck-role="compile-progress-message"/);
    assert.match(source, /data-ck-role="compile-progress-elapsed"/);
    assert.doesNotMatch(source, /`\$\{progress\.percentage\.toFixed\(0\)\}%/);
});

test('visible bar exposes bounded progress semantics for accessibility and UI automation', () => {
    assert.match(source, /role="progressbar"/);
    assert.match(source, /aria-valuemin=\{0\}/);
    assert.match(source, /aria-valuemax=\{100\}/);
    assert.match(source, /aria-valuenow=\{progress\.indeterminate \? undefined : percentageValue\}/);
});

test('active overlay exposes a temporary read-only build evidence contract', () => {
    for (const attribute of [
        'data-ck-build-evidence-schema',
        'data-ck-build-run-id',
        'data-ck-build-kind',
        'data-ck-build-fqbn',
        'data-ck-build-port',
        'data-ck-build-workspace-fingerprint',
    ]) {
        assert.match(source, new RegExp(`${attribute}=\\{buildEvidence\\.`));
    }
    assert.match(source, /ForegroundBuildEvidence extends ProjectBuildEvidenceSeed/);
    for (const field of [
        'schemaVersion: 1',
        'runId: string',
        "kind: 'compile' | 'upload'",
        'boardPackageId: string',
        'fqbn: string',
        'coreId: string',
        'coreVersion: string',
        'workspaceSha256: string',
        'generatedCodeSha256: string',
        'recordedAt: string',
    ]) {
        assert.match(evidenceSource, new RegExp(`readonly ${field.replace(/[|]/g, '\\|')}`));
    }
});
