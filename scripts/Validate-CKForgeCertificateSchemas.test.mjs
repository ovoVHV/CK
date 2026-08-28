import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { validateJsonSchema } from './JsonSchemaValidator.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function readJson(relativePath) {
  return JSON.parse(readFileSync(join(ROOT, relativePath), 'utf8'));
}

function errors(schema, value) {
  return validateJsonSchema(schema, value).errors;
}

const performanceCertificateSchema = readJson(
  'docs/schemas/ck-forge-local-performance-certificate.schema.json',
);
const nativeRelinkCertificateSchema = readJson(
  'docs/schemas/ck-forge-native-relink-certificate.schema.json',
);
const artifactBundleSchema = readJson(
  'docs/schemas/ck-forge-performance-artifact-bundle.schema.json',
);

const performanceCertificate = Object.freeze({
  schemaId: 'ck.forge.local-performance-certificate',
  schemaVersion: 2,
  candidateSha256: 'a'.repeat(64),
  reportSha256: 'b'.repeat(64),
  artifactManifestSha256: 'c'.repeat(64),
});

const nativeRelinkCertificate = Object.freeze({
  schemaId: 'ck.forge.local-performance-certificate',
  schemaVersion: 4,
  candidateProfile: 'native-relink-compile-only',
  evidenceSha256: 'd'.repeat(64),
  reportSha256: 'e'.repeat(64),
});

test('ordinary performance v2 and NativeRelink v4 certificates have independent closed schemas', () => {
  assert.deepEqual(errors(performanceCertificateSchema, performanceCertificate), []);
  assert.deepEqual(errors(nativeRelinkCertificateSchema, nativeRelinkCertificate), []);

  assert.notDeepEqual(
    errors(performanceCertificateSchema, nativeRelinkCertificate),
    [],
    'NativeRelink v4 must not be accepted as an ordinary performance v2 certificate',
  );
  assert.notDeepEqual(
    errors(nativeRelinkCertificateSchema, performanceCertificate),
    [],
    'ordinary performance v2 must not be accepted as a NativeRelink certificate',
  );
});

test('NativeRelink certificate v4 rejects legacy, malformed, and extensible-looking envelopes', () => {
  for (const candidate of [
    { ...nativeRelinkCertificate, schemaVersion: 3 },
    { ...nativeRelinkCertificate, candidateProfile: 'quick-fast' },
    { ...nativeRelinkCertificate, evidenceSha256: 'D'.repeat(64) },
    { ...nativeRelinkCertificate, evidenceSha256: 'short' },
    { ...nativeRelinkCertificate, schemaId: 'ck.forge.native-relink-certificate' },
    { ...nativeRelinkCertificate, artifactManifestSha256: 'f'.repeat(64) },
  ]) {
    assert.notDeepEqual(errors(nativeRelinkCertificateSchema, candidate), []);
  }
  const { reportSha256: _missing, ...withoutReportHash } = nativeRelinkCertificate;
  assert.notDeepEqual(errors(nativeRelinkCertificateSchema, withoutReportHash), []);
});

test('certificate families reject cross-version, future-version, and hybrid envelopes', () => {
  const cases = [
    [
      'portable v2 payload relabeled as NativeRelink v4',
      nativeRelinkCertificateSchema,
      { ...performanceCertificate, schemaVersion: 4 },
    ],
    [
      'NativeRelink v4 payload relabeled as portable v2',
      performanceCertificateSchema,
      { ...nativeRelinkCertificate, schemaVersion: 2 },
    ],
    [
      'portable v2 unknown future version',
      performanceCertificateSchema,
      { ...performanceCertificate, schemaVersion: 999 },
    ],
    [
      'NativeRelink v4 unknown future version',
      nativeRelinkCertificateSchema,
      { ...nativeRelinkCertificate, schemaVersion: 999 },
    ],
    [
      'portable v2 hybrid with NativeRelink fields',
      performanceCertificateSchema,
      { ...performanceCertificate, candidateProfile: 'native-relink-compile-only', evidenceSha256: 'd'.repeat(64) },
    ],
    [
      'NativeRelink v4 hybrid with portable fields',
      nativeRelinkCertificateSchema,
      { ...nativeRelinkCertificate, candidateSha256: 'a'.repeat(64), artifactManifestSha256: 'c'.repeat(64) },
    ],
    [
      'hybrid payload with the portable version',
      performanceCertificateSchema,
      { ...nativeRelinkCertificate, schemaVersion: 2, candidateSha256: 'a'.repeat(64) },
    ],
    [
      'hybrid payload with the NativeRelink version',
      nativeRelinkCertificateSchema,
      { ...performanceCertificate, schemaVersion: 4, candidateProfile: 'native-relink-compile-only', evidenceSha256: 'd'.repeat(64) },
    ],
  ];

  for (const [label, schema, value] of cases) {
    assert.notDeepEqual(errors(schema, value), [], `${label} must be rejected`);
  }

  // The historical schemaId is shared by design; version and closed payload
  // shape are therefore both mandatory family discriminators.
  assert.notDeepEqual(
    errors(performanceCertificateSchema, { ...performanceCertificate, schemaVersion: 4 }),
    [],
    'the shared schemaId must not make a wrong version portable certificate valid',
  );
  assert.notDeepEqual(
    errors(nativeRelinkCertificateSchema, { ...nativeRelinkCertificate, schemaVersion: 2 }),
    [],
    'the shared schemaId must not make a wrong version NativeRelink certificate valid',
  );
});

test('performance artifact bundle schema binds candidate, capture report and manifest hashes', () => {
  const bundle = {
    schemaId: 'ck.forge.performance-artifact-bundle',
    schemaVersion: 1,
    candidateSha256: 'a'.repeat(64),
    captureReportSha256: 'b'.repeat(64),
    artifactManifestSha256: 'c'.repeat(64),
    representativeLane: 'native',
    representativeTrialId: 'trial-001',
    representativeStage: 'simple-return',
  };
  assert.deepEqual(errors(artifactBundleSchema, bundle), []);
  assert.notDeepEqual(errors(artifactBundleSchema, { ...bundle, representativeLane: 'ck' }), []);
  assert.notDeepEqual(errors(artifactBundleSchema, { ...bundle, candidateSha256: 'short' }), []);
  assert.notDeepEqual(errors(artifactBundleSchema, { ...bundle, allowFast: true }), []);
});

test('unified specification index exposes both certificate contracts without aliasing them', () => {
  const index = readJson('docs/specification/index.json');
  const contract = index.contracts.find(
    (candidate) => candidate.id === 'ck.forge-performance-qualification',
  );
  assert.ok(contract, 'CK Forge performance qualification contract is indexed');
  assert.equal(contract.version, 4);
  assert.equal(
    contract.local_certificate_schema,
    'docs/schemas/ck-forge-local-performance-certificate.schema.json',
  );
  assert.equal(
    contract.native_relink_certificate_schema,
    'docs/schemas/ck-forge-native-relink-certificate.schema.json',
  );
  assert.equal(contract.native_relink_certificate_version, 4);
  assert.equal(contract.native_relink_binding_version, 3);
  assert.equal(
    contract.artifact_bundle_schema,
    'docs/schemas/ck-forge-performance-artifact-bundle.schema.json',
  );
  assert.equal(contract.installer_entrypoint, 'scripts/Install-CKForgePerformanceQualification.cjs');
  assert.equal(contract.portable_performance_scope, 'exact-portable-simple-source');
  assert.equal(contract.portable_performance_grants_target_wide_fast, false);
  assert.equal(contract.qualification_candidate_route, 'qualification-token-probe');
  assert.deepEqual(contract.qualification_simple_build_modes, ['full-build', 'fast-relink']);
  assert.equal(contract.qualification_edit_build_mode, 'fast-relink');
  assert.equal(contract.qualification_fallback_allowed, false);
  assert.notEqual(contract.local_certificate_schema, contract.native_relink_certificate_schema);

  assert.equal(readJson(contract.local_certificate_schema).properties.schemaVersion.const, 2);
  assert.equal(readJson(contract.native_relink_certificate_schema).properties.schemaVersion.const, 4);
});
