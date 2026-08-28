import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');
const schemaPath = path.join(repositoryRoot, 'docs', 'schemas', 'ck-project.schema.json');
const specificationPath = path.join(repositoryRoot, 'docs', 'ck-project-format-v1.md');
const workspacePath = path.join(repositoryRoot, 'apps', 'desktop', 'src', 'components', 'Workspace.tsx');

function readSchema() {
  return JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
}

// The repository intentionally does not add a second JSON-Schema runtime just
// for this static contract test. This checks the closed top-level v1 identity;
// CK's Rust tests exercise the actual migration and rejection paths.
function validateTopLevelIdentity(schema, value) {
  const errors = [];
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    return ['root must be an object'];
  }
  for (const field of schema.required) {
    if (!Object.hasOwn(value, field)) errors.push(`missing ${field}`);
  }
  for (const [field, contract] of Object.entries(schema.properties)) {
    if (!Object.hasOwn(value, field)) continue;
    if (Object.hasOwn(contract, 'const') && value[field] !== contract.const) {
      errors.push(`${field} must equal ${JSON.stringify(contract.const)}`);
    }
    if (contract.type === 'string' && typeof value[field] !== 'string') {
      errors.push(`${field} must be string`);
    }
  }
  return errors;
}

test('CK Project Format schema fixes the v1 identity and remains extension-safe', () => {
  const schema = readSchema();
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, true);
  assert.equal(schema.properties.format.const, 'ck-project');
  assert.equal(schema.properties.schema_version.const, 1);
  assert.equal(schema.properties.migration_version.const, 1);
  assert.deepEqual(schema.required.slice(0, 3), [
    'format',
    'schema_version',
    'migration_version',
  ]);
  assert.equal(schema.properties.ck_block_packages.$ref, '#/$defs/blockPackageInventory');
  assert.equal(schema.$defs.blockPackageInventory.properties.schema_version.const, 1);
});

test('a representative v1 project satisfies the schema identity contract', () => {
  const schema = readSchema();
  const project = {
    format: 'ck-project',
    schema_version: 1,
    migration_version: 1,
    name: 'blink',
    board: 'arduino:avr:uno',
    board_package_id: 'arduino:avr:uno',
    xml: '<xml></xml>',
    code: 'void setup() {}',
    options: '{}',
    future_extension: { retained: true },
  };
  assert.deepEqual(validateTopLevelIdentity(schema, project), []);
});

test('future and mislabeled project documents fail the v1 identity contract', () => {
  const schema = readSchema();
  const base = {
    format: 'ck-project',
    schema_version: 1,
    migration_version: 1,
    name: 'future',
    board: 'arduino:avr:uno',
    xml: '',
  };

  assert.match(
    validateTopLevelIdentity(schema, { ...base, schema_version: 2 }).join('\n'),
    /schema_version must equal 1/,
  );
  assert.match(
    validateTopLevelIdentity(schema, { ...base, migration_version: 2 }).join('\n'),
    /migration_version must equal 1/,
  );
  assert.match(
    validateTopLevelIdentity(schema, { ...base, format: 'project.ckpkg' }).join('\n'),
    /format must equal "ck-project"/,
  );
});

test('the normative document records compatibility, atomicity and evidence boundaries', () => {
  const specification = fs.readFileSync(specificationPath, 'utf8');
  for (const phrase of [
    '新建工程使用 `.ck`',
    '只读打开不改写磁盘',
    '未知字段保持原值',
    '另存为”以当前源工程的完整 JSON 对象为基底',
    '同一目录创建唯一临时文件',
    '工程检查点和崩溃恢复快照',
  ]) {
    assert.match(specification, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('workspace dialogs prefer .ck while retaining legacy .maker compatibility', () => {
  const workspace = fs.readFileSync(workspacePath, 'utf8');
  assert.match(workspace, /-恢复\.ck/);
  assert.doesNotMatch(workspace, /-恢复\.maker/);
  const filters = workspace.match(/extensions: \['ck', 'maker'\]/g) || [];
  assert.ok(filters.length >= 3, 'save, recovery and open dialogs must prefer .ck');
  assert.match(workspace, /sourcePath: formalSaveProjectPath/);
  assert.match(
    workspace,
    /sourcePath: \/\\\.\(\?:ck\|maker\)\$\/i\.test\(saveAsSession\.projectPath\)\s*\? saveAsSession\.projectPath\s*:\s*null/,
  );
  assert.match(workspace, /sourcePath: null/);
});
