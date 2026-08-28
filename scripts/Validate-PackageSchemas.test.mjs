import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { validateJsonSchema } from './JsonSchemaValidator.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (relativePath) =>
  JSON.parse(readFileSync(join(ROOT, relativePath), 'utf8'));

const librarySchema = readJson('docs/schemas/ck-library.schema.json');
const qualitySchema = readJson(
  'docs/schemas/ck-package-quality-report.schema.json',
);
const blocksV1Schema = readJson('docs/schemas/ck-blocks.schema.json');
const blocksV2Schema = readJson('docs/schemas/ck-blocks-v2.schema.json');
const generatorSchema = readJson('docs/schemas/ck-generator.schema.json');
const migrationsSchema = readJson('docs/schemas/ck-migrations.schema.json');
const sdkReleaseChannelSchema = readJson(
  'docs/schemas/ck-extension-sdk-release-channel.schema.json',
);
const sdkReleaseArtifactSchema = readJson(
  'docs/schemas/ck-extension-sdk-release-artifact.schema.json',
);

const validate = (schema, value) => validateJsonSchema(schema, value).errors;

function assertValid(schema, value, message) {
  assert.deepEqual(validate(schema, value), [], message);
}

function assertInvalid(schema, value, message) {
  assert.notDeepEqual(validate(schema, value), [], message);
}

test('Extension SDK release channel and artifact sidecar have closed machine contracts', () => {
  const channel = readJson('docs/extension-sdk/release-channel.json');
  assertValid(sdkReleaseChannelSchema, channel, 'repository release channel');
  assertInvalid(
    sdkReleaseChannelSchema,
    { ...channel, public_url: 'https://example.invalid/sdk.zip' },
    'local channel must not claim a public URL',
  );
  assertInvalid(
    sdkReleaseChannelSchema,
    { ...channel, publication_status: 'published', public_url: null },
    'published channel requires HTTPS URL',
  );

  const sidecar = {
    schema_version: 1,
    channel: 'stable',
    sdk_version: '1.0.0',
    license: 'Apache-2.0',
    artifact_file: 'CK-Extension-SDK-1.0.0.zip',
    bytes: 123,
    sha256: 'a'.repeat(64),
    public_url: null,
    publication_status: 'local-artifact-ready',
    release_channel_sha256: 'b'.repeat(64),
    integrity_boundary: 'Integrity is not publisher identity.',
  };
  assertValid(sdkReleaseArtifactSchema, sidecar, 'release sidecar');
  assertInvalid(sdkReleaseArtifactSchema, { ...sidecar, sha256: 'short' }, 'bad artifact hash');
});

test('library schema is one extensible envelope for distributed v1 and v2 block packages', () => {
  assert.equal(librarySchema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(librarySchema.additionalProperties, true);
  assert.equal(Object.hasOwn(librarySchema.properties, 'schema_version'), false);
  assert.equal(Object.hasOwn(librarySchema.properties, 'blocks'), false);
  assert.equal(Object.hasOwn(librarySchema.properties, 'entrypoints'), false);

  const cases = [
    ['ck_example_serial_blocks', blocksV1Schema],
    ['ck_example_i2c_sensor_v2', blocksV2Schema],
  ];
  for (const [folder, blocksSchema] of cases) {
    const base = `examples/importable-packages/${folder}`;
    assertValid(librarySchema, readJson(`${base}/library.json`), `${folder} library.json`);
    assertValid(blocksSchema, readJson(`${base}/ck-blocks.json`), `${folder} ck-blocks.json`);
  }

  assertValid(
    librarySchema,
    readJson('examples/importable-packages/ck_example_native_deep/library.json'),
    'ck_example_native_deep library.json',
  );

  assertValid(librarySchema, {
    id: 'vendor_native_driver',
    name: 'Vendor native driver',
    version: '1.2.3-beta.1+build.7',
    architectures: 'avr, esp32',
    repository: { type: 'git', url: 'https://example.invalid/driver.git' },
    build: { libArchive: false },
    extensions: { vendor_specific: true },
  });
});

test('library schema rejects deterministic manifest errors', () => {
  const valid = { id: 'vendor_sensor', name: 'Sensor', version: '1.0.0' };
  assertInvalid(librarySchema, { name: 'Sensor', version: '1.0.0' }, 'id is required');
  assertInvalid(librarySchema, { ...valid, id: '../sensor' }, 'unsafe id');
  assertInvalid(librarySchema, { ...valid, version: '1.0' }, 'non-SemVer version');
  assertInvalid(librarySchema, { ...valid, includes: ['../secret.h'] }, 'unsafe include');
  assertInvalid(librarySchema, { ...valid, includes: ['driver.c'] }, 'source is not a header');
});

test('ck-generator schema accepts distributed declarative generators and rejects executable shapes', () => {
  for (const folder of ['ck_example_serial_blocks', 'ck_example_i2c_sensor_v2']) {
    assertValid(
      generatorSchema,
      readJson(`examples/importable-packages/${folder}/blocks/ck-generator.json`),
      `${folder} ck-generator.json`,
    );
  }
  assertInvalid(generatorSchema, {
    schema: 'ck-generator',
    version: 1,
    rules: [{ type: 'bad', kind: 'statement', template: 'ok', execute: 'window.polluted = true' }],
  }, 'unknown executable field');
  assertInvalid(generatorSchema, {
    schema: 'ck-generator',
    version: 1,
    rules: [{ type: 'bad', kind: 'statement', template: 'x'.repeat(16 * 1024 + 1) }],
  }, 'oversized template');
});

test('offline schema engine covers CK assertion keywords and fails closed on unknown contracts', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'items', 'mode'],
    propertyNames: { pattern: '^[a-z]+$' },
    dependentRequired: { enabled: ['mode'] },
    properties: {
      id: { type: 'string', minLength: 2, maxLength: 8, pattern: '^[a-z]+$' },
      enabled: { type: 'boolean' },
      mode: { enum: ['read', 'write'] },
      count: { type: 'integer', minimum: 0, maximum: 10 },
      items: {
        type: 'array',
        minItems: 1,
        maxItems: 3,
        uniqueItems: true,
        items: { $ref: '#/$defs/item' },
        contains: { const: 'ok' },
        minContains: 1,
        maxContains: 1,
      },
    },
    allOf: [{ if: { properties: { enabled: { const: true } } }, then: { required: ['count'] } }],
    $defs: { item: { anyOf: [{ const: 'ok' }, { type: 'string', pattern: '^v' }] } },
  };
  assertValid(schema, { id: 'sensor', enabled: true, mode: 'read', count: 2, items: ['ok', 'v1'] });
  assertInvalid(schema, { id: 'S', enabled: true, mode: 'read', items: ['ok', 'ok'] });
  const unknown = validateJsonSchema({ type: 'string', futureAssertion: true }, 'value');
  assert.equal(unknown.valid, false);
  assert.equal(unknown.schema_errors, 1);
  assert.equal(unknown.errors[0].kind, 'schema');
  assert.match(unknown.errors[0].message, /unsupported JSON Schema keyword/);
  assertInvalid({ type: 'array', uniqueItems: 'yes' }, [], 'malformed assertion schemas fail closed');
  assertInvalid({ $ref: 'https://example.invalid/schema.json' }, {}, 'remote refs are never fetched');
});

const sha256 = 'a'.repeat(64);
const passedReport = {
  schema_version: 2,
  package_kind: 'block-library',
  package_id: 'vendor_sensor',
  status: 'passed',
  source_content_sha256: sha256,
  error_count: 0,
  warning_count: 0,
  checks: [
    { code: 'library-manifest', status: 'passed', message: 'Manifest is valid.' },
  ],
  validator_id: 'ck.local-package-quality',
  validator_version: '0.1.0',
  ruleset_version: 'ck-package-quality-v2',
  generated_at: '2026-07-13T12:00:00.000Z',
  contract_sha256: 'b'.repeat(64),
  certification_level: 'local-static',
  validated_consumers: [
    'import-gate',
    'runtime-loader',
    'block-catalog',
    'pin-preflight',
    'compile-resolver',
  ],
};

test('quality report schema accepts finalized v2 pass, warning, and failure reports', () => {
  assertValid(qualitySchema, passedReport);

  assertValid(qualitySchema, {
    ...passedReport,
    checks: [
      {
        code: 'bundled-library/vendor_sensor/library-manifest',
        status: 'passed',
        message: 'Bundled child library manifest is valid.',
      },
    ],
  });

  assertValid(qualitySchema, {
    ...passedReport,
    status: 'passed_with_warnings',
    warning_count: 1,
    checks: [
      { code: 'missing-license', status: 'warning', message: 'License is missing.' },
    ],
  });

  assertValid(qualitySchema, {
    ...passedReport,
    package_kind: 'arduino-library',
    validated_consumers: ['import-gate', 'compile-resolver'],
  });

  assertValid(qualitySchema, {
    ...passedReport,
    package_id: null,
    status: 'failed',
    source_content_sha256: null,
    error_count: 1,
    checks: [
      { code: 'missing-package-id', status: 'error', message: 'Package id is missing.' },
    ],
    validator_id: null,
    validator_version: null,
    ruleset_version: null,
    generated_at: null,
    contract_sha256: null,
    certification_level: null,
    validated_consumers: [],
  });
});

test('quality report schema rejects stale, malformed, inconsistent, or extended evidence', () => {
  assertInvalid(qualitySchema, { ...passedReport, schema_version: 1 }, 'stale schema');
  assertInvalid(qualitySchema, { ...passedReport, status: 'pending' }, 'pending report');
  assertInvalid(
    qualitySchema,
    { ...passedReport, source_content_sha256: 'abc' },
    'malformed content hash',
  );
  assertInvalid(
    qualitySchema,
    {
      ...passedReport,
      checks: [{ code: 'late-warning', status: 'warning', message: 'Warning.' }],
    },
    'passed report containing a warning',
  );
  assertInvalid(
    qualitySchema,
    { ...passedReport, validated_consumers: ['import-gate'] },
    'successful runtime report without runtime-loader provenance',
  );
  assertInvalid(
    qualitySchema,
    {
      ...passedReport,
      package_kind: 'arduino-library',
      validated_consumers: ['import-gate'],
    },
    'successful native report without compile-resolver provenance',
  );
  assertInvalid(
    qualitySchema,
    {
      ...passedReport,
      checks: [
        {
          code: 'bundled-library/../content-hash',
          status: 'passed',
          message: 'Unsafe traversal-like code.',
        },
      ],
    },
    'quality check code with a traversal segment',
  );
  assertInvalid(
    qualitySchema,
    {
      ...passedReport,
      checks: [
        {
          code: 'bundled-library\\vendor_sensor\\content-hash',
          status: 'passed',
          message: 'Unsafe backslash code.',
        },
      ],
    },
    'quality check code with backslashes',
  );
  assertInvalid(qualitySchema, { ...passedReport, unsigned_claim: true }, 'unknown field');
});

test('declarative migration schema accepts the v2 package fixture and rejects code or loose destinations', () => {
  const fixture = readJson(
    'examples/importable-packages/ck_example_i2c_sensor_v2/ck-migrations.json',
  );
  assertValid(migrationsSchema, fixture, 'ck_example_i2c_sensor_v2 migration contract');

  const scripted = structuredClone(fixture);
  scripted.migrations[0].operations[0].script = 'return globalThis';
  assertInvalid(migrationsSchema, scripted, 'arbitrary script property');

  const unknownOperation = structuredClone(fixture);
  unknownOperation.migrations[0].operations = [{ op: 'javascript', code: 'run()' }];
  assertInvalid(migrationsSchema, unknownOperation, 'executable migration operation');

  const rangedDestination = structuredClone(fixture);
  rangedDestination.migrations[0].to = '>=2.0.0 <3.0.0';
  assertInvalid(migrationsSchema, rangedDestination, 'destination must be exact SemVer');

  const looseSource = structuredClone(fixture);
  looseSource.migrations[0].from = '^1.0.0';
  assertInvalid(migrationsSchema, looseSource, 'v1 only supports explicit comparator ranges');

  const wrongPackage = structuredClone(fixture);
  wrongPackage.package_id = '../other';
  assertInvalid(migrationsSchema, wrongPackage, 'package ID binding is safe');
});
