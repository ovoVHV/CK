import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { validateJsonSchema } from './JsonSchemaValidator.mjs';

const schema = JSON.parse(await readFile(
  new URL('../docs/schemas/ck-project-package.schema.json', import.meta.url),
  'utf8',
));
const parityCorpus = JSON.parse(await readFile(
  new URL('../docs/schemas/ck-project-package-parity-corpus.json', import.meta.url),
  'utf8',
));

const summary = {
  projectName: 'C6 项目', blockCount: 3,
  workspaceSha256: 'a'.repeat(64), generatedCodeSha256: 'b'.repeat(64),
  boardName: 'ESP32-C6', boardId: 'esp32c6', boardPackageId: 'builtin-c6',
  fqbn: 'esp32:esp32:esp32c6:FlashSize=16M', coreId: 'esp32:esp32', coreVersion: '3.3.6',
  compileState: 'passed', compileRecordedAt: '2026-07-16T00:00:00Z',
  flashUsedBytes: 100, flashTotalBytes: 1000, ramUsedBytes: 20, ramTotalBytes: 200,
  dependencyLockAvailable: false, dependencyLockSha256: null, dependencyCount: 0,
  dependenciesAllVersioned: false, hardwareState: 'verified', hardwareChip: 'ESP32-C6',
  hardwareFlashBytes: 16777216, hardwarePsramBytes: null, checkpointCount: 2,
  healthSummary: '无确定问题', healthPassCount: 1, healthWarningCount: 0,
  healthErrorCount: 0, healthInfoCount: 0,
};

const file = (path, role, redacted) => ({
  path, role, redacted, size: 12, sha256: 'c'.repeat(64),
});

const valid = {
  schemaVersion: 1, format: 'ck-project-package', kind: 'project-submission',
  generatedBy: { product: 'CK Desktop', version: '1.0.0', component: 'project-submission-exporter' },
  generatedAt: '2026-07-16T00:00:00Z', sourceScope: 'no_source',
  sourceDisclosureAcknowledged: false, networkUsed: false, uploadPerformed: false,
  summary,
  files: [
    file('report/project-acceptance.json', 'acceptance_report', true),
    file('report/project-acceptance.html', 'printable_report', true),
  ],
};

test('project.ckpkg manifest schema accepts the fixed safe contract', () => {
  assert.deepEqual(validateJsonSchema(schema, valid).errors, []);
});

test('project.ckpkg manifest schema rejects unknown fields, network claims, paths and role mismatch', () => {
  for (const invalid of [
    { ...valid, futureField: true },
    { ...valid, networkUsed: true },
    { ...valid, uploadPerformed: true },
    { ...valid, files: [...valid.files, file('../escape', 'editable_project', false)] },
    { ...valid, files: [file('report/project-acceptance.json', 'generated_source', true), valid.files[1]] },
    { ...valid, sourceScope: 'generated_source', sourceDisclosureAcknowledged: false },
  ]) {
    assert.notDeepEqual(validateJsonSchema(schema, invalid).errors, []);
  }
});

test('project.ckpkg schema enforces the same four source-scope path sets as Rust', () => {
  const workspaceFile = file('project/workspace.json', 'editable_project', false);
  const sourceFile = file('source/generated.ino', 'generated_source', false);
  for (const accepted of [
    { ...valid, sourceScope: 'editable_project', sourceDisclosureAcknowledged: true, files: [...valid.files, workspaceFile] },
    { ...valid, sourceScope: 'generated_source', sourceDisclosureAcknowledged: true, files: [...valid.files, sourceFile] },
    { ...valid, sourceScope: 'editable_and_generated', sourceDisclosureAcknowledged: true, files: [...valid.files, workspaceFile, sourceFile] },
  ]) assert.deepEqual(validateJsonSchema(schema, accepted).errors, []);

  for (const rejected of [
    { ...valid, sourceScope: 'no_source', sourceDisclosureAcknowledged: true },
    { ...valid, sourceScope: 'editable_project', sourceDisclosureAcknowledged: true },
    { ...valid, sourceScope: 'editable_project', sourceDisclosureAcknowledged: true, files: [...valid.files, sourceFile] },
    { ...valid, sourceScope: 'generated_source', sourceDisclosureAcknowledged: true, files: [...valid.files, workspaceFile] },
    { ...valid, sourceScope: 'editable_and_generated', sourceDisclosureAcknowledged: true, files: [...valid.files, workspaceFile] },
  ]) assert.notDeepEqual(validateJsonSchema(schema, rejected).errors, []);
});

test('project.ckpkg schema matches Rust date, lowercase hash, duplicate-path and per-role size limits', () => {
  const report = valid.files[0];
  for (const rejected of [
    { ...valid, generatedAt: 'not-a-date' },
    { ...valid, summary: { ...summary, compileRecordedAt: 'tomorrow-ish' } },
    { ...valid, summary: { ...summary, workspaceSha256: 'A'.repeat(64) } },
    { ...valid, files: [...valid.files, { ...report, role: 'acceptance_report', sha256: 'd'.repeat(64) }] },
    { ...valid, files: [{ ...report, size: 2097153 }, valid.files[1]] },
    { ...valid, files: [report, { ...valid.files[1], size: 4194305 }] },
  ]) assert.notDeepEqual(validateJsonSchema(schema, rejected).errors, []);
});

test('public Schema rejects every mutation in the shared Rust parity corpus', () => {
  assert.equal(parityCorpus.schemaVersion, 1);
  for (const item of parityCorpus.cases) {
    const candidate = structuredClone(valid);
    if (item.id === 'invalid-generated-at') candidate.generatedAt = 'not-a-date';
    else if (item.id === 'uppercase-payload-sha256') candidate.files[0].sha256 = 'A'.repeat(64);
    else if (item.id === 'no-source-forged-disclosure') candidate.sourceDisclosureAcknowledged = true;
    else if (item.id === 'oversized-acceptance-report-record') candidate.files[0].size = 2097153;
    else if (item.id === 'editable-scope-missing-workspace') {
      candidate.sourceScope = 'editable_project';
      candidate.sourceDisclosureAcknowledged = true;
    } else throw new Error(`unknown parity mutation: ${item.id}`);
    assert.equal(item.expected, 'reject');
    assert.notDeepEqual(
      validateJsonSchema(schema, candidate).errors,
      [],
      `Schema unexpectedly accepted parity case ${item.id}`,
    );
  }
});
