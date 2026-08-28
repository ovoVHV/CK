import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  formatJsonSchemaErrors,
  loadJsonSchema,
  validateJsonSchema,
} from './JsonSchemaValidator.mjs';

const SCHEMA_ROOT = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'docs', 'schemas');
const LIBRARY_SCHEMA = loadJsonSchema(join(SCHEMA_ROOT, 'ck-library.schema.json'));
const BLOCKS_V1_SCHEMA = loadJsonSchema(join(SCHEMA_ROOT, 'ck-blocks.schema.json'));
const BLOCKS_V2_SCHEMA = loadJsonSchema(join(SCHEMA_ROOT, 'ck-blocks-v2.schema.json'));
const GENERATOR_SCHEMA = loadJsonSchema(join(SCHEMA_ROOT, 'ck-generator.schema.json'));
const MIGRATIONS_SCHEMA = loadJsonSchema(join(SCHEMA_ROOT, 'ck-migrations.schema.json'));

const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const PACKAGE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SOURCE_EXTENSIONS = new Set(['.c', '.cc', '.cpp', '.cxx', '.s']);
const HEADER_EXTENSIONS = new Set(['.h', '.hh', '.hpp', '.hxx', '.inc', '.ipp', '.tpp']);

const ordinal = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const own = (value, property) => Object.prototype.hasOwnProperty.call(value, property);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isScalar = value => (
  value === null
  || typeof value === 'string'
  || typeof value === 'boolean'
  || (typeof value === 'number' && Number.isFinite(value))
);
const slash = value => value.split(sep).join('/');

function applySchema(schema, value, label, errors) {
  const result = validateJsonSchema(schema, value);
  errors.push(...formatJsonSchemaErrors(result, label));
  return result.valid;
}

export function isSafePackagePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return false;
  if (value.includes('\\') || value.includes(':') || value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false;
  if (/[\u0000-\u001f\u007f]/.test(value)) return false;
  const segments = value.split('/');
  return segments.every(segment => segment.length > 0 && segment !== '.' && segment !== '..');
}

function readJson(path, errors, label) {
  try {
    const raw = readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw);
  } catch (error) {
    errors.push(`${label} is not valid JSON: ${error.message}`);
    return null;
  }
}

function expectExactKeys(value, allowed, required, path, errors) {
  if (!isObject(value)) {
    errors.push(`${path} must be an object`);
    return false;
  }
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) errors.push(`${path}.${key} is not allowed`);
  }
  for (const key of required) {
    if (!own(value, key)) errors.push(`${path}.${key} is required`);
  }
  return true;
}

export function listPackageFiles(rootPath) {
  const root = resolve(rootPath);
  const files = [];
  const errors = [];
  const walk = (directory) => {
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => ordinal(left.name, right.name));
    for (const entry of entries) {
      const fullPath = join(directory, entry.name);
      const stat = lstatSync(fullPath);
      const relativePath = slash(relative(root, fullPath));
      if (stat.isSymbolicLink()) {
        errors.push(`symbolic links and junctions are forbidden: ${relativePath}`);
        continue;
      }
      if (!isSafePackagePath(relativePath)) {
        errors.push(`unsafe package path: ${relativePath}`);
        continue;
      }
      if (entry.isDirectory()) walk(fullPath);
      else if (entry.isFile()) files.push(relativePath);
      else errors.push(`unsupported filesystem entry: ${relativePath}`);
    }
  };
  walk(root);
  files.sort(ordinal);
  const caseFolded = new Map();
  for (const file of files) {
    const key = file.toLocaleLowerCase('en-US');
    if (caseFolded.has(key)) errors.push(`case-insensitive duplicate path: ${caseFolded.get(key)} / ${file}`);
    else caseFolded.set(key, file);
  }
  return { files, errors };
}

export function inspectArduinoLayout(rootPath, precomputedFiles) {
  const files = precomputedFiles ?? listPackageFiles(rootPath).files;
  const isSource = file => SOURCE_EXTENSIONS.has(extname(file).toLowerCase());
  const isHeader = file => HEADER_EXTENSIONS.has(extname(file).toLowerCase());
  const srcSources = files.filter(file => file.startsWith('src/') && isSource(file));
  const srcHeaders = files.filter(file => file.startsWith('src/') && isHeader(file));
  const rootSources = files.filter(file => !file.includes('/') && isSource(file));
  const rootHeaders = files.filter(file => !file.includes('/') && isHeader(file));
  const utilitySources = files.filter(file => file.startsWith('utility/') && isSource(file));
  const utilityHeaders = files.filter(file => file.startsWith('utility/') && isHeader(file));
  const hasSrcLayout = srcSources.length > 0 || srcHeaders.length > 0;
  const hasLegacyLayout = rootSources.length > 0 || rootHeaders.length > 0
    || utilitySources.length > 0 || utilityHeaders.length > 0;
  if (hasSrcLayout) {
    return {
      kind: hasLegacyLayout ? 'mixed' : 'src-1.5',
      sources: [...srcSources, ...(hasLegacyLayout ? [...rootSources, ...utilitySources] : [])].sort(ordinal),
      headers: [...srcHeaders, ...(hasLegacyLayout ? [...rootHeaders, ...utilityHeaders] : [])].sort(ordinal),
      publicRoot: 'src',
      mixedLegacySources: [...rootSources, ...utilitySources].sort(ordinal),
      mixedLegacyHeaders: [...rootHeaders, ...utilityHeaders].sort(ordinal),
      headerOnly: srcSources.length === 0 && rootSources.length === 0 && utilitySources.length === 0,
    };
  }
  if (hasLegacyLayout) {
    return {
      kind: 'legacy-1.0',
      sources: [...rootSources, ...utilitySources].sort(ordinal),
      headers: [...rootHeaders, ...utilityHeaders].sort(ordinal),
      publicRoot: '.',
      mixedLegacySources: [],
      mixedLegacyHeaders: [],
      headerOnly: rootSources.length === 0 && utilitySources.length === 0,
    };
  }
  return {
    kind: 'none',
    sources: [],
    headers: [],
    publicRoot: null,
    mixedLegacySources: [],
    mixedLegacyHeaders: [],
    headerOnly: false,
  };
}

export function parseLibraryProperties(path, errors = []) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
  } catch (error) {
    errors.push(`library.properties cannot be read: ${error.message}`);
    return {};
  }
  const properties = {};
  raw.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) {
      errors.push(`library.properties:${index + 1} must use key=value`);
      return;
    }
    const key = trimmed.slice(0, separator).trim().toLowerCase();
    const value = trimmed.slice(separator + 1).trim();
    if (!key || !value) {
      errors.push(`library.properties:${index + 1} has an empty key or value`);
      return;
    }
    if (own(properties, key)) {
      errors.push(`library.properties contains duplicate key: ${key}`);
      return;
    }
    properties[key] = value;
  });
  return properties;
}

function splitCommaAware(value) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const character of value) {
    if (character === '(') depth += 1;
    if (character === ')') depth -= 1;
    if (character === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else {
      current += character;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts.filter(Boolean);
}

function dependencyNamesFromProperties(value) {
  if (!value) return [];
  return splitCommaAware(value)
    .map(dependency => dependency.replace(/\s*\([^)]*\)\s*$/, '').trim())
    .filter(Boolean)
    .sort(ordinal);
}

function dependencyNamesFromJson(value, errors) {
  if (value === undefined) return [];
  if (isObject(value)) return Object.keys(value).sort(ordinal);
  if (Array.isArray(value)) {
    const names = [];
    for (const [index, dependency] of value.entries()) {
      if (typeof dependency === 'string' && dependency.trim()) names.push(dependency.trim());
      else if (isObject(dependency) && typeof (dependency.name ?? dependency.id) === 'string') {
        names.push((dependency.name ?? dependency.id).trim());
      } else errors.push(`library.json.dependencies[${index}] has no dependency name`);
    }
    return names.sort(ordinal);
  }
  errors.push('library.json.dependencies must be an object or array');
  return [];
}

function normalizeArchitectures(value, label, errors, { required = true } = {}) {
  const items = Array.isArray(value)
    ? value
    : typeof value === 'string' ? value.split(',') : [];
  const normalized = items.map(item => typeof item === 'string' ? item.trim() : '').filter(Boolean);
  if (required && normalized.length === 0) errors.push(`${label} must declare at least one architecture`);
  return [...new Set(normalized)].sort(ordinal);
}

function normalizeIncludes(value, label, sourceRoot, files, errors, { required = true } = {}) {
  const items = Array.isArray(value)
    ? value
    : typeof value === 'string' ? value.split(',') : [];
  const normalized = [];
  const seen = new Set();
  for (const raw of items) {
    const header = typeof raw === 'string' ? raw.trim() : '';
    if (!isSafePackagePath(header) || !HEADER_EXTENSIONS.has(extname(header).toLowerCase())) {
      errors.push(`${label} contains unsafe or non-header include: ${JSON.stringify(raw)}`);
      continue;
    }
    const key = header.toLocaleLowerCase('en-US');
    if (seen.has(key)) {
      errors.push(`${label} contains duplicate include: ${header}`);
      continue;
    }
    seen.add(key);
    const expected = sourceRoot === '.' ? header : `${sourceRoot}/${header}`;
    if (!files.includes(expected)) {
      errors.push(`${label} references missing public header: ${header}`);
    }
    normalized.push(header);
  }
  if (required && normalized.length === 0) errors.push(`${label} must declare at least one public header`);
  return normalized.sort(ordinal);
}

function validateLibraryEnvelope(root, files, errors, warnings) {
  if (!files.includes('library.json')) {
    errors.push('library.json is required');
    return { manifest: null, properties: null };
  }
  const manifest = readJson(join(root, 'library.json'), errors, 'library.json');
  if (!isObject(manifest)) {
    if (manifest !== null) errors.push('library.json must be an object');
    return { manifest: null, properties: null };
  }
  applySchema(LIBRARY_SCHEMA, manifest, 'library.json', errors);
  for (const field of ['id', 'name', 'version']) {
    if (typeof manifest[field] !== 'string' || !manifest[field].trim()) {
      errors.push(`library.json.${field} must be a non-empty string`);
    }
  }
  if (typeof manifest.id === 'string') {
    if (!PACKAGE_ID_RE.test(manifest.id)) errors.push(`library.json.id is invalid: ${manifest.id}`);
    if (manifest.id !== basename(root)) {
      errors.push(`library.json.id ${manifest.id} must match directory ${basename(root)}`);
    }
  }
  if (typeof manifest.version === 'string' && !SEMVER_RE.test(manifest.version)) {
    errors.push(`library.json.version is not SemVer: ${manifest.version}`);
  }
  if (!files.includes('README.md')) errors.push('README.md is required');
  if (!files.includes('LICENSE')) errors.push('LICENSE is required');

  let properties = null;
  if (files.includes('library.properties')) {
    properties = parseLibraryProperties(join(root, 'library.properties'), errors);
    for (const key of ['name', 'version', 'architectures']) {
      if (!properties[key]) errors.push(`library.properties requires ${key}`);
    }
    if (properties.version && !SEMVER_RE.test(properties.version)) {
      errors.push(`library.properties version is not SemVer: ${properties.version}`);
    }
    if (properties.version && manifest.version && properties.version !== manifest.version) {
      errors.push(`library.properties version ${properties.version} does not match library.json ${manifest.version}`);
    }
  } else warnings.push('library.properties:not_declared — accepted for legacy/native compatibility; Arduino Library Manager metadata is unavailable.');
  return { manifest, properties };
}

function validateNativeLibrary(root, files, manifest, properties, layout, errors, warnings) {
  if (files.includes('ck-blocks.json')) errors.push('pure native package must not contain ck-blocks.json');
  if (layout.kind === 'none') errors.push('native package must contain at least one source or header in src/, package root, or utility/');
  if (layout.kind === 'mixed') {
    warnings.push('arduino-layout:mixed — src/ and legacy root/utility files coexist; real compile profiles must confirm which files the selected Core consumes.');
  }
  if (layout.kind === 'legacy-1.0') {
    warnings.push('arduino-layout:legacy — root/utility layout is accepted for compatibility; prefer recursive src/ for new libraries.');
  }
  if (layout.headerOnly) warnings.push('arduino-layout:header_only — no translation units are present; compile validation must exercise a public header.');

  const jsonArchitectures = normalizeArchitectures(
    manifest.architectures,
    'library.json.architectures',
    errors,
    { required: false },
  );
  const propertyArchitectures = properties
    ? normalizeArchitectures(properties.architectures, 'library.properties architectures', errors)
    : [];
  if (properties && jsonArchitectures.length > 0
    && JSON.stringify(jsonArchitectures) !== JSON.stringify(propertyArchitectures)) {
      errors.push('library.json and library.properties architectures differ');
  }
  if (!properties && jsonArchitectures.length === 0) {
    warnings.push('architectures:not_declared — compatibility remains unknown until library.json.architectures is provided.');
  }

  const publicRoot = layout.publicRoot ?? 'src';
  const jsonIncludes = normalizeIncludes(
    manifest.includes,
    'library.json.includes',
    publicRoot,
    files,
    errors,
    { required: false },
  );
  const propertyIncludes = properties
    ? normalizeIncludes(
      properties.includes,
      'library.properties includes',
      publicRoot,
      files,
      errors,
      { required: false },
    )
    : [];
  if (properties && jsonIncludes.length > 0 && propertyIncludes.length > 0
    && JSON.stringify(jsonIncludes) !== JSON.stringify(propertyIncludes)) {
      errors.push('library.json and library.properties includes differ');
  }
  if (jsonIncludes.length === 0 && propertyIncludes.length === 0 && layout.headers.length > 0) {
    warnings.push('includes:not_declared — public headers exist but neither manifest declares the intended include surface.');
  }
  const jsonDependencies = dependencyNamesFromJson(manifest.dependencies, errors);
  const propertyDependencies = dependencyNamesFromProperties(properties?.depends);
  if (properties && JSON.stringify(jsonDependencies) !== JSON.stringify(propertyDependencies)) {
    errors.push('library.json dependencies and library.properties depends differ');
  }
  if (typeof manifest.license !== 'string' || !manifest.license.trim()) {
    warnings.push('license:spdx_not_declared — LICENSE exists, but library.json has no SPDX identifier.');
  } else if (properties?.license && properties.license !== manifest.license) {
    errors.push('library.json and library.properties license differ');
  }

  if (properties) {
    for (const key of [
      'name', 'version', 'author', 'maintainer', 'sentence', 'paragraph',
      'category', 'url', 'architectures',
    ]) {
      if (!properties[key]) errors.push(`library.properties requires ${key}`);
    }
  }
}

function validateBlockManifest(root, files, manifest, errors) {
  if (!files.includes('ck-blocks.json')) {
    errors.push('block package requires ck-blocks.json');
    return null;
  }
  const blocks = readJson(join(root, 'ck-blocks.json'), errors, 'ck-blocks.json');
  if (!isObject(blocks)) {
    if (blocks !== null) errors.push('ck-blocks.json must be an object');
    return null;
  }
  if (blocks.schema_version === 1) applySchema(BLOCKS_V1_SCHEMA, blocks, 'ck-blocks.json', errors);
  else if (blocks.schema_version === 2) applySchema(BLOCKS_V2_SCHEMA, blocks, 'ck-blocks.json', errors);
  if (![1, 2].includes(blocks.schema_version)) errors.push('ck-blocks.json schema_version must be 1 or 2');
  if (blocks.id !== manifest.id) errors.push('ck-blocks.json id must match library.json id');
  if (!isObject(blocks.entrypoints)) errors.push('ck-blocks.json entrypoints must be an object');
  else {
    for (const key of ['blocks', 'generator', 'toolbox']) {
      const entrypoint = blocks.entrypoints[key];
      if (!isSafePackagePath(entrypoint) || !files.includes(entrypoint)) {
        errors.push(`ck-blocks.json entrypoint ${key} is unsafe or missing: ${entrypoint}`);
      }
    }
  }
  if (!Array.isArray(blocks.blocks) || blocks.blocks.length === 0) {
    errors.push('ck-blocks.json must declare at least one block');
  }
  if (blocks.schema_version === 2) {
    if (!isObject(blocks.license) || typeof blocks.license.spdx_id !== 'string') {
      errors.push('v2 ck-blocks.json requires license.spdx_id');
    }
    if (!isObject(blocks.license) || !isSafePackagePath(blocks.license.file) || !files.includes(blocks.license.file)) {
      errors.push('v2 ck-blocks.json license.file must reference a package file');
    }
  }
  validateDeclarativeBlockRuntime(root, files, blocks, errors);
  return blocks;
}

function collectStringValues(value, output = []) {
  if (typeof value === 'string') output.push(value);
  else if (Array.isArray(value)) value.forEach(item => collectStringValues(item, output));
  else if (isObject(value)) Object.values(value).forEach(item => collectStringValues(item, output));
  return output;
}

const GENERATOR_TEMPLATE_TOKEN = /^(field|field_json|value|statement):([A-Za-z_][A-Za-z0-9_]{0,63})$/;
const MAX_DECLARATIVE_DOCUMENT_BYTES = 512 * 1024;
const MAX_TOTAL_GENERATOR_TEMPLATE_BYTES = 384 * 1024;
const MAX_GENERATOR_TEMPLATE_BYTES = 16 * 1024;
const MAX_DECLARATIVE_DATA_NODES = 10_000;
const MAX_DECLARATIVE_DATA_DEPTH = 64;
const FORBIDDEN_RESOURCE_SCHEME = /(?:^|[\s"'(=])(?:https?|file|data|blob|ftp|ws|wss|javascript|vbscript):/i;
const PROTOCOL_RELATIVE_RESOURCE = /(?:^|[\s"'(=])\/\//;
const CSS_RESOURCE = /\burl\s*\(/i;
const RESOURCE_KEYS = new Set(['src', 'href', 'xlink:href', 'url']);
const CALLBACK_KEYS = new Set(['callbackkey', 'custom']);
const PROTOTYPE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function setDifference(left, right) {
  return [...left].filter(value => !right.has(value)).sort(ordinal);
}

function sameSet(left, right) {
  return left.size === right.size && [...left].every(value => right.has(value));
}

function validateDeclarativeDataSafety(value, label, errors) {
  let nodes = 0;
  const visit = (candidate, path, depth) => {
    nodes += 1;
    if (nodes > MAX_DECLARATIVE_DATA_NODES || depth > MAX_DECLARATIVE_DATA_DEPTH) {
      errors.push(`${label} exceeds the structural safety limit at ${path}`);
      return;
    }
    if (typeof candidate === 'string') {
      if (FORBIDDEN_RESOURCE_SCHEME.test(candidate)
        || PROTOCOL_RELATIVE_RESOURCE.test(candidate)
        || CSS_RESOURCE.test(candidate)) {
        errors.push(`${path} contains an external or inline resource reference`);
      }
      return;
    }
    if (candidate === null || typeof candidate !== 'object') return;
    if (Array.isArray(candidate)) {
      candidate.forEach((item, index) => visit(item, `${path}[${index}]`, depth + 1));
      return;
    }
    if (String(candidate.type ?? '').trim().toLowerCase() === 'field_image') {
      errors.push(`${path} uses field_image, which is disabled for third-party declarative data`);
    }
    for (const [key, child] of Object.entries(candidate)) {
      const normalized = key.trim().toLowerCase();
      if (PROTOTYPE_KEYS.has(normalized)) errors.push(`${path}.${key} uses a prototype-sensitive key`);
      if (RESOURCE_KEYS.has(normalized) && child !== null && child !== '') {
        errors.push(`${path}.${key} is a resource-bearing field and is disabled`);
      }
      if (CALLBACK_KEYS.has(normalized)) errors.push(`${path}.${key} may invoke runtime callbacks and is disabled`);
      visit(child, `${path}.${key}`, depth + 1);
    }
  };
  visit(value, label, 0);
}

function collectTemplateParameters(value, label, errors) {
  const parameters = { fields: new Set(), values: new Set(), statements: new Set() };
  if (typeof value !== 'string' || value.length === 0) {
    errors.push(`${label} must be a non-empty string`);
    return parameters;
  }
  const byteLength = Buffer.byteLength(value, 'utf8');
  if (byteLength > MAX_GENERATOR_TEMPLATE_BYTES) {
    errors.push(`${label} exceeds the 16 KiB UTF-8 template limit`);
  }
  if (value.includes('\0')) errors.push(`${label} contains a NUL byte`);
  const delimiters = [...value.matchAll(/\{\{|\}\}/g)];
  let open = null;
  for (const delimiter of delimiters) {
    if (delimiter[0] === '{{') {
      if (open !== null) {
        errors.push(`${label} contains a nested or unterminated placeholder`);
        open = delimiter.index;
      } else open = delimiter.index;
      continue;
    }
    if (open === null) {
      errors.push(`${label} contains an unmatched placeholder terminator`);
      continue;
    }
    const token = value.slice(open + 2, delimiter.index);
    const match = GENERATOR_TEMPLATE_TOKEN.exec(token);
    if (!match) errors.push(`${label} contains an invalid placeholder: {{${token}}}`);
    else if (match[1] === 'field' || match[1] === 'field_json') parameters.fields.add(match[2]);
    else if (match[1] === 'value') parameters.values.add(match[2]);
    else parameters.statements.add(match[2]);
    open = null;
  }
  if (open !== null) errors.push(`${label} contains an unterminated placeholder`);
  return parameters;
}

function mergeTemplateParameters(target, source) {
  for (const key of ['fields', 'values', 'statements']) {
    for (const value of source[key]) target[key].add(value);
  }
}

function definitionShape(definition) {
  const output = own(definition, 'output') && definition.output !== null && definition.output !== false;
  const previous = own(definition, 'previousStatement') && definition.previousStatement !== false;
  const next = own(definition, 'nextStatement') && definition.nextStatement !== false;
  if (output && !previous && !next) return 'value';
  if (!output && previous && next) return 'statement';
  if (!output && !previous && next) return 'hat';
  if (!output && previous && !next) return 'terminal';
  return 'unknown';
}

function definitionParameters(definition, index, errors) {
  const contract = {
    fields: new Set(), values: new Set(), statements: new Set(),
    shape: definitionShape(definition),
  };
  const argumentKeys = Object.keys(definition)
    .filter(key => /^args\d+$/.test(key))
    .sort(ordinal);
  for (const key of argumentKeys) {
    if (!Array.isArray(definition[key])) {
      errors.push(`block definition ${index}.${key} must be an array`);
      continue;
    }
    definition[key].forEach((argument, argumentIndex) => {
      if (!isObject(argument)) {
        errors.push(`block definition ${index}.${key}[${argumentIndex}] must be an object`);
        return;
      }
      const argumentType = typeof argument.type === 'string' ? argument.type : '';
      const target = argumentType.startsWith('field_')
        ? contract.fields
        : argumentType === 'input_value'
          ? contract.values
          : argumentType === 'input_statement' ? contract.statements : null;
      if (!target) return;
      if (argumentType === 'field_label' && argument.name === undefined) return;
      if (typeof argument.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(argument.name)) {
        errors.push(`block definition ${index}.${key}[${argumentIndex}] has an invalid parameter name`);
      } else if (target.has(argument.name)) {
        errors.push(`block definition ${index} contains duplicate parameter ${argument.name}`);
      } else target.add(argument.name);
    });
  }
  return contract;
}

function assertParameterSet(label, declared, actual, errors) {
  if (sameSet(declared, actual)) return;
  errors.push(`${label} mismatch (metadata only: [${setDifference(declared, actual).join(', ')}]; definition only: [${setDifference(actual, declared).join(', ')}])`);
}

function validateV2BlockContract(block, definition, generatorRule, files, index, errors) {
  const label = `ck-blocks.json.blocks[${index}] (${block.type})`;
  const definitionContract = definition.contract;
  const metadataFields = new Set();
  const metadataValues = new Set();
  const metadataStatements = new Set();
  for (const [fieldIndex, field] of block.fields.entries()) {
    if (metadataFields.has(field.name)) errors.push(`${label}.fields[${fieldIndex}] duplicates ${field.name}`);
    metadataFields.add(field.name);
  }
  for (const [inputIndex, input] of block.inputs.entries()) {
    const target = input.kind === 'statement' ? metadataStatements : metadataValues;
    if (target.has(input.name) || metadataValues.has(input.name) || metadataStatements.has(input.name)) {
      errors.push(`${label}.inputs[${inputIndex}] duplicates ${input.name}`);
    }
    target.add(input.name);
  }
  assertParameterSet(`${label} fields`, metadataFields, definitionContract.fields, errors);
  assertParameterSet(`${label} value inputs`, metadataValues, definitionContract.values, errors);
  assertParameterSet(`${label} statement inputs`, metadataStatements, definitionContract.statements, errors);

  const generatorContract = generatorRule.parameters;
  for (const [nameSet, metadataSet, parameterKind] of [
    [generatorContract.fields, metadataFields, 'field'],
    [generatorContract.values, metadataValues, 'value input'],
    [generatorContract.statements, metadataStatements, 'statement input'],
  ]) {
    const missing = setDifference(nameSet, metadataSet);
    if (missing.length > 0) errors.push(`${label} generator references undeclared ${parameterKind}(s): ${missing.join(', ')}`);
  }

  if (definitionContract.shape !== block.kind) {
    errors.push(`${label} kind '${block.kind}' does not match Blockly connection shape '${definitionContract.shape}'`);
  }
  const expectedGeneratorKind = block.kind === 'value' ? 'expression' : 'statement';
  if (generatorRule.kind !== expectedGeneratorKind) {
    errors.push(`${label} requires a ${expectedGeneratorKind} generator, found ${generatorRule.kind}`);
  }
  const expectedGenerationShape = block.kind === 'value'
    ? 'expression'
    : block.kind === 'hat' ? 'event' : 'statement';
  if (block.generation.shape !== expectedGenerationShape) {
    errors.push(`${label}.generation.shape must be ${expectedGenerationShape} for kind ${block.kind}`);
  }
  const expectedOutput = block.kind === 'value' ? 'value' : 'none';
  if (block.output.connection !== expectedOutput) {
    errors.push(`${label}.output.connection must be ${expectedOutput} for kind ${block.kind}`);
  }

  for (const [resourceIndex, resource] of block.hardware.resources.entries()) {
    const source = resource.source;
    if (source?.kind === 'field' && !metadataFields.has(source.name)) {
      errors.push(`${label}.hardware.resources[${resourceIndex}] references unknown field ${source.name}`);
    }
    if (source?.kind === 'input' && !metadataValues.has(source.name) && !metadataStatements.has(source.name)) {
      errors.push(`${label}.hardware.resources[${resourceIndex}] references unknown input ${source.name}`);
    }
  }
  for (const [exampleIndex, example] of block.examples.entries()) {
    for (const name of Object.keys(example.field_values ?? {})) {
      if (!metadataFields.has(name)) errors.push(`${label}.examples[${exampleIndex}] references unknown field ${name}`);
    }
    for (const name of Object.keys(example.input_values ?? {})) {
      if (!metadataValues.has(name) && !metadataStatements.has(name)) {
        errors.push(`${label}.examples[${exampleIndex}] references unknown input ${name}`);
      }
    }
    for (const path of [example.project, example.generated_code].filter(Boolean)) {
      if (!files.includes(path)) errors.push(`${label}.examples[${exampleIndex}] references missing package file ${path}`);
    }
  }
}

function validateDeclarativeBlockRuntime(root, files, manifest, errors) {
  if (!isObject(manifest.entrypoints)) return;
  const { blocks: blocksPath, generator: generatorPath, toolbox: toolboxPath } = manifest.entrypoints;
  if (![blocksPath, generatorPath, toolboxPath].every(path => isSafePackagePath(path) && files.includes(path))) {
    return;
  }
  if (extname(blocksPath || '').toLowerCase() !== '.json') {
    errors.push('CK 1.0 block definition entrypoint must be JSON; executable blocks.js is disabled');
    return;
  }
  if (extname(generatorPath || '').toLowerCase() !== '.json') {
    errors.push('CK 1.0 generator entrypoint must be ck-generator JSON; executable generator.js is disabled');
    return;
  }
  if (!['.json', '.xml'].includes(extname(toolboxPath || '').toLowerCase())) {
    errors.push('CK 1.0 toolbox entrypoint must be JSON or XML');
    return;
  }

  const definitionsSource = readFileSync(join(root, blocksPath), 'utf8');
  if (Buffer.byteLength(definitionsSource, 'utf8') > MAX_DECLARATIVE_DOCUMENT_BYTES) {
    errors.push(`${blocksPath} exceeds the 512 KiB declarative document limit`);
  }
  const definitions = readJson(join(root, blocksPath), errors, blocksPath);
  validateDeclarativeDataSafety(definitions, blocksPath, errors);
  const definitionList = Array.isArray(definitions)
    ? definitions
    : isObject(definitions) && Array.isArray(definitions.blocks) ? definitions.blocks : [];
  if (definitionList.length === 0) errors.push('block definition JSON must contain at least one block');
  if (definitionList.length > 256) errors.push('block definition JSON exceeds the 256 block limit');
  const definitionTypes = new Set();
  const definitionContracts = new Map();
  for (const [index, definition] of definitionList.entries()) {
    if (!isObject(definition) || typeof definition.type !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(definition.type)) {
      errors.push(`block definition ${index} has an invalid type`);
      continue;
    }
    if (definitionTypes.has(definition.type)) errors.push(`duplicate block definition type: ${definition.type}`);
    definitionTypes.add(definition.type);
    definitionContracts.set(definition.type, {
      definition,
      contract: definitionParameters(definition, index, errors),
    });
    for (const text of collectStringValues(definition)) {
      if (/^(?:https?:|file:|data:|javascript:|\/\/)/i.test(text.trim())) {
        errors.push(`block definition ${definition.type} contains a forbidden external or inline resource`);
      }
    }
  }

  const generatorSource = readFileSync(join(root, generatorPath), 'utf8');
  if (Buffer.byteLength(generatorSource, 'utf8') > MAX_DECLARATIVE_DOCUMENT_BYTES) {
    errors.push(`${generatorPath} exceeds the 512 KiB declarative document limit`);
  }
  const generator = readJson(join(root, generatorPath), errors, generatorPath);
  const generatorTypes = new Set();
  const generatorContracts = new Map();
  let aggregateTemplateBytes = 0;
  if (!isObject(generator) || generator.schema !== 'ck-generator' || generator.version !== 1 || !Array.isArray(generator.rules)) {
    errors.push('generator entrypoint must be a ck-generator version 1 document');
  } else {
    applySchema(GENERATOR_SCHEMA, generator, generatorPath, errors);
    for (const [index, rule] of generator.rules.entries()) {
      if (!isObject(rule) || typeof rule.type !== 'string' || !definitionTypes.has(rule.type)) {
        errors.push(`ck-generator rule ${index} targets an undefined block`);
        continue;
      }
      if (generatorTypes.has(rule.type)) errors.push(`duplicate ck-generator rule: ${rule.type}`);
      generatorTypes.add(rule.type);
      if (!['statement', 'expression'].includes(rule.kind) || typeof rule.template !== 'string' || !rule.template) {
        errors.push(`ck-generator rule ${index} has an invalid kind or template`);
      }
      const parameters = { fields: new Set(), values: new Set(), statements: new Set() };
      const templates = [
        [`ck-generator rule ${index}.template`, rule.template],
        ...['includes', 'declarations', 'setup'].flatMap(section => (
          isObject(rule[section])
            ? Object.entries(rule[section]).map(([key, value]) => [`ck-generator rule ${index}.${section}.${key}`, value])
            : []
        )),
      ];
      for (const [label, template] of templates) {
        if (typeof template === 'string') aggregateTemplateBytes += Buffer.byteLength(template, 'utf8');
        mergeTemplateParameters(parameters, collectTemplateParameters(template, label, errors));
      }
      generatorContracts.set(rule.type, { kind: rule.kind, parameters });
      for (const text of collectStringValues(rule)) {
        if (/^(?:https?:|file:|data:|javascript:|\/\/)/i.test(text.trim())) {
          errors.push(`ck-generator rule ${index} contains a forbidden resource value`);
        }
      }
    }
  }
  if (aggregateTemplateBytes > MAX_TOTAL_GENERATOR_TEMPLATE_BYTES) {
    errors.push('ck-generator templates exceed the 384 KiB aggregate UTF-8 limit');
  }

  const declaredTypes = new Set((manifest.blocks || []).map(block => block?.type).filter(Boolean));
  for (const type of declaredTypes) {
    if (!definitionTypes.has(type)) errors.push(`declared block has no JSON definition: ${type}`);
    if (!generatorTypes.has(type)) errors.push(`declared block has no ck-generator rule: ${type}`);
  }
  for (const type of definitionTypes) {
    if (!declaredTypes.has(type)) errors.push(`JSON definition is not declared in ck-blocks.json: ${type}`);
  }

  for (const [type, generatorContract] of generatorContracts) {
    const definitionContract = definitionContracts.get(type)?.contract;
    if (!definitionContract) continue;
    for (const [used, declared, kind] of [
      [generatorContract.parameters.fields, definitionContract.fields, 'field'],
      [generatorContract.parameters.values, definitionContract.values, 'value input'],
      [generatorContract.parameters.statements, definitionContract.statements, 'statement input'],
    ]) {
      const missing = setDifference(used, declared);
      if (missing.length > 0) errors.push(`generator for ${type} references unknown ${kind}(s): ${missing.join(', ')}`);
    }
  }

  if (manifest.schema_version === 2 && Array.isArray(manifest.blocks)) {
    const seenMetadataTypes = new Set();
    manifest.blocks.forEach((block, index) => {
      if (!isObject(block) || typeof block.type !== 'string') return;
      if (seenMetadataTypes.has(block.type)) errors.push(`duplicate ck-blocks.json block type: ${block.type}`);
      seenMetadataTypes.add(block.type);
      const definition = definitionContracts.get(block.type);
      const generatorRule = generatorContracts.get(block.type);
      if (definition && generatorRule) validateV2BlockContract(block, definition, generatorRule, files, index, errors);
    });
  }

  const toolboxText = readFileSync(join(root, toolboxPath), 'utf8');
  if (Buffer.byteLength(toolboxText, 'utf8') > MAX_DECLARATIVE_DOCUMENT_BYTES) {
    errors.push(`${toolboxPath} exceeds the 512 KiB declarative document limit`);
  }
  if (/(?:https?:|file:|data:|blob:|ftp:|ws:|wss:|javascript:|vbscript:|\/\/)/i.test(toolboxText)) {
    errors.push('toolbox contains a forbidden external or inline resource');
  }
  if (/<!\s*(?:DOCTYPE|ENTITY)\b|<\?xml-stylesheet\b/i.test(toolboxText)
    || /<\s*(?:script|image|img|iframe|object|embed|link|style|foreignObject)\b/i.test(toolboxText)
    || /\b(?:src|href|xlink:href)\s*=/i.test(toolboxText)
    || /\b(?:callbackKey|custom)\s*=/i.test(toolboxText)) {
    errors.push('toolbox contains an executable, resource-capable, or callback-bearing XML construct');
  }
  let toolboxTypes = [...toolboxText.matchAll(/\btype\s*=\s*["']([^"']+)["']/gi)]
    .map(match => match[1]);
  if (extname(toolboxPath).toLowerCase() === '.json') {
    const toolbox = readJson(join(root, toolboxPath), errors, toolboxPath);
    validateDeclarativeDataSafety(toolbox, toolboxPath, errors);
    const visit = value => {
      if (Array.isArray(value)) value.forEach(visit);
      else if (isObject(value)) {
        if (typeof value.type === 'string' && !['category', 'sep', 'button', 'label'].includes(value.kind)) {
          toolboxTypes.push(value.type);
        }
        Object.values(value).forEach(visit);
      }
    };
    visit(toolbox);
  }
  toolboxTypes = [...new Set(toolboxTypes)];
  for (const type of toolboxTypes) {
    if (!declaredTypes.has(type) || !definitionTypes.has(type)) {
      errors.push(`toolbox references an undeclared block type: ${type}`);
    }
  }
}

function parseSemVer(value) {
  const match = SEMVER_RE.exec(value);
  if (!match) return null;
  return { major: BigInt(match[1]), minor: BigInt(match[2]), patch: BigInt(match[3]), prerelease: match[4] ?? '' };
}

function compareSimpleSemVer(left, right) {
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  if (left.prerelease === right.prerelease) return 0;
  if (!left.prerelease) return 1;
  if (!right.prerelease) return -1;
  return left.prerelease < right.prerelease ? -1 : 1;
}

function selectorMatches(selector, version) {
  if (SEMVER_RE.test(selector)) return compareSimpleSemVer(parseSemVer(selector), version) === 0;
  const tokens = selector.split(/\s+/);
  if (tokens.length === 0) return false;
  return tokens.every(token => {
    const match = /^(<=|>=|<|>|=)(.+)$/.exec(token);
    if (!match || !SEMVER_RE.test(match[2])) return false;
    const comparison = compareSimpleSemVer(version, parseSemVer(match[2]));
    return match[1] === '<' ? comparison < 0
      : match[1] === '<=' ? comparison <= 0
        : match[1] === '>' ? comparison > 0
          : match[1] === '>=' ? comparison >= 0
            : comparison === 0;
  });
}

function validateMigrationManifest(root, files, packageId, errors) {
  if (!files.includes('ck-migrations.json')) return null;
  const migrations = readJson(join(root, 'ck-migrations.json'), errors, 'ck-migrations.json');
  if (isObject(migrations)) applySchema(MIGRATIONS_SCHEMA, migrations, 'ck-migrations.json', errors);
  if (!expectExactKeys(
    migrations,
    ['schema_version', 'package_id', 'migrations'],
    ['schema_version', 'package_id', 'migrations'],
    'ck-migrations.json',
    errors,
  )) return null;
  if (migrations.schema_version !== 1) errors.push('ck-migrations.json schema_version must be 1');
  if (migrations.package_id !== packageId) errors.push('ck-migrations.json package_id must match library.json id');
  if (!Array.isArray(migrations.migrations) || migrations.migrations.length === 0) {
    errors.push('ck-migrations.json migrations must be a non-empty array');
    return migrations;
  }
  const stepIds = new Set();
  migrations.migrations.forEach((step, stepIndex) => {
    const path = `ck-migrations.json.migrations[${stepIndex}]`;
    if (!expectExactKeys(step, ['id', 'from', 'to', 'operations'], ['id', 'from', 'to', 'operations'], path, errors)) return;
    if (typeof step.id !== 'string' || !PACKAGE_ID_RE.test(step.id)) errors.push(`${path}.id is invalid`);
    if (stepIds.has(step.id)) errors.push(`${path}.id is duplicated`);
    stepIds.add(step.id);
    if (typeof step.from !== 'string' || (!SEMVER_RE.test(step.from) && !selectorMatches(step.from, parseSemVer('1.0.0')) && !/^(?:<=|>=|<|>|=)/.test(step.from))) {
      errors.push(`${path}.from is not a supported SemVer selector`);
    } else if (typeof step.from === 'string') {
      const tokens = SEMVER_RE.test(step.from) ? [step.from] : step.from.split(/\s+/).map(token => token.replace(/^(?:<=|>=|<|>|=)/, ''));
      if (tokens.some(token => !SEMVER_RE.test(token))) errors.push(`${path}.from is not a supported SemVer selector`);
    }
    if (typeof step.to !== 'string' || !SEMVER_RE.test(step.to)) errors.push(`${path}.to must be exact SemVer`);
    if (!Array.isArray(step.operations) || step.operations.length === 0) {
      errors.push(`${path}.operations must be a non-empty array`);
      return;
    }
    step.operations.forEach((operation, operationIndex) => {
      const operationPath = `${path}.operations[${operationIndex}]`;
      if (!isObject(operation)) {
        errors.push(`${operationPath} must be an object`);
        return;
      }
      if (operation.op === 'renameBlockType') {
        expectExactKeys(operation, ['op', 'from', 'to'], ['op', 'from', 'to'], operationPath, errors);
        if (typeof operation.from !== 'string' || typeof operation.to !== 'string' || operation.from === operation.to) {
          errors.push(`${operationPath} requires different string from/to block types`);
        }
      } else if (operation.op === 'renameField') {
        expectExactKeys(operation, ['op', 'block_type', 'from', 'to'], ['op', 'block_type', 'from', 'to'], operationPath, errors);
        if (![operation.block_type, operation.from, operation.to].every(value => typeof value === 'string' && value.trim())) {
          errors.push(`${operationPath} requires block_type and field names`);
        }
      } else if (operation.op === 'mapEnum') {
        expectExactKeys(operation, ['op', 'block_type', 'field', 'mappings'], ['op', 'block_type', 'field', 'mappings'], operationPath, errors);
        if (typeof operation.block_type !== 'string' || typeof operation.field !== 'string') {
          errors.push(`${operationPath} requires block_type and field`);
        }
        if (!Array.isArray(operation.mappings) || operation.mappings.length === 0) {
          errors.push(`${operationPath}.mappings must be non-empty`);
        } else {
          const sources = new Set();
          operation.mappings.forEach((mapping, mappingIndex) => {
            const mappingPath = `${operationPath}.mappings[${mappingIndex}]`;
            if (!expectExactKeys(mapping, ['from', 'to'], ['from', 'to'], mappingPath, errors)) return;
            if (!isScalar(mapping.from) || !isScalar(mapping.to)) errors.push(`${mappingPath} values must be JSON scalars`);
            const key = JSON.stringify([typeof mapping.from, mapping.from]);
            if (sources.has(key)) errors.push(`${mappingPath}.from is duplicated`);
            sources.add(key);
          });
        }
      } else {
        errors.push(`${operationPath}.op is unsupported; executable migrations are forbidden`);
      }
    });
  });
  return migrations;
}

function collectFixtureBlocks(workspace, errors) {
  const blocks = [];
  const visit = (block, path) => {
    if (!isObject(block) || typeof block.type !== 'string') {
      errors.push(`${path} is not a valid serialized block`);
      return;
    }
    blocks.push(block);
    if (isObject(block.inputs)) {
      for (const [name, input] of Object.entries(block.inputs)) {
        if (!isObject(input)) continue;
        if (own(input, 'block')) visit(input.block, `${path}.inputs.${name}.block`);
        if (own(input, 'shadow')) visit(input.shadow, `${path}.inputs.${name}.shadow`);
      }
    }
    if (isObject(block.next)) {
      if (own(block.next, 'block')) visit(block.next.block, `${path}.next.block`);
      if (own(block.next, 'shadow')) visit(block.next.shadow, `${path}.next.shadow`);
    }
  };
  const roots = workspace?.blocks?.blocks;
  if (!Array.isArray(roots)) {
    errors.push('migration fixture must contain blocks.blocks array');
    return blocks;
  }
  roots.forEach((block, index) => visit(block, `blocks.blocks[${index}]`));
  return blocks;
}

function validateMigrationFixtures(root, files, manifest, libraryVersion, errors) {
  const fixtureFiles = files.filter(file => /^migration-fixtures\/legacy-.+\.workspace\.json$/.test(file));
  if (!manifest && fixtureFiles.length > 0) errors.push('migration fixtures require ck-migrations.json');
  if (manifest && fixtureFiles.length === 0) errors.push('ck-migrations.json requires at least one legacy workspace fixture');
  const coverage = [];
  if (!manifest) return coverage;
  for (const fixtureFile of fixtureFiles) {
    const match = /^migration-fixtures\/legacy-(.+)\.workspace\.json$/.exec(fixtureFile);
    const version = match ? parseSemVer(match[1]) : null;
    if (!version) {
      errors.push(`${fixtureFile} must encode an exact legacy SemVer in its filename`);
      continue;
    }
    const candidates = manifest.migrations.filter(step => (
      step.to === libraryVersion && selectorMatches(step.from, version)
    ));
    if (candidates.length !== 1) {
      errors.push(`${fixtureFile} must resolve to exactly one direct migration into ${libraryVersion}`);
      continue;
    }
    const workspace = readJson(join(root, ...fixtureFile.split('/')), errors, fixtureFile);
    if (!isObject(workspace)) continue;
    const opaqueBefore = JSON.stringify(collectOpaqueState(workspace));
    const cloned = structuredClone(workspace);
    const blocks = collectFixtureBlocks(cloned, errors);
    const operationCoverage = [];
    for (const operation of candidates[0].operations) {
      if (operation.op === 'renameBlockType') {
        const matches = blocks.filter(block => block.type === operation.from);
        if (matches.length === 0) errors.push(`${fixtureFile} does not cover renameBlockType ${operation.from}`);
        matches.forEach(block => { block.type = operation.to; });
        operationCoverage.push({ op: operation.op, matches: matches.length });
      } else if (operation.op === 'renameField') {
        const matches = blocks.filter(block => (
          block.type === operation.block_type && isObject(block.fields) && own(block.fields, operation.from)
        ));
        for (const block of matches) {
          if (own(block.fields, operation.to)) errors.push(`${fixtureFile} has ambiguous field collision ${operation.to}`);
          else {
            block.fields[operation.to] = block.fields[operation.from];
            delete block.fields[operation.from];
          }
        }
        if (matches.length === 0) errors.push(`${fixtureFile} does not cover renameField ${operation.from}`);
        operationCoverage.push({ op: operation.op, matches: matches.length });
      } else if (operation.op === 'mapEnum') {
        const matches = blocks.filter(block => (
          block.type === operation.block_type && isObject(block.fields) && own(block.fields, operation.field)
        ));
        const coveredMappings = new Set();
        for (const block of matches) {
          const value = block.fields[operation.field];
          const mappingIndex = operation.mappings.findIndex(mapping => (
            typeof mapping.from === typeof value && mapping.from === value
          ));
          if (mappingIndex < 0) errors.push(`${fixtureFile} has unmapped enum value ${JSON.stringify(value)}`);
          else {
            coveredMappings.add(mappingIndex);
            block.fields[operation.field] = operation.mappings[mappingIndex].to;
          }
        }
        operation.mappings.forEach((_mapping, index) => {
          if (!coveredMappings.has(index)) errors.push(`${fixtureFile} does not exercise mapEnum mapping ${index}`);
        });
        operationCoverage.push({ op: operation.op, matches: matches.length });
      }
    }
    if (JSON.stringify(collectOpaqueState(cloned)) !== opaqueBefore) {
      errors.push(`${fixtureFile} migration coverage touched opaque extraState/mutation`);
    }
    coverage.push({ fixture: fixtureFile, step: candidates[0].id, operations: operationCoverage });
  }
  return coverage;
}

function collectOpaqueState(value, result = []) {
  if (Array.isArray(value)) {
    value.forEach(entry => collectOpaqueState(entry, result));
  } else if (isObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (key === 'extraState' || key === 'mutation') result.push(structuredClone(entry));
      else collectOpaqueState(entry, result);
    }
  }
  return result;
}

export function validateImportablePackage(rootPath, options = {}) {
  const root = resolve(rootPath);
  const kind = options.kind ?? 'auto';
  const listing = listPackageFiles(root);
  const errors = [...listing.errors];
  const warnings = [];
  const files = listing.files;
  if (files.includes('.ck-quality-report.json')) errors.push('source package must not contain a stale .ck-quality-report.json');
  const { manifest, properties } = validateLibraryEnvelope(root, files, errors, warnings);
  const layout = inspectArduinoLayout(root, files);
  let effectiveKind = kind;
  if (effectiveKind === 'auto') effectiveKind = files.includes('ck-blocks.json') ? 'block' : 'native';
  let migrations = null;
  let migrationCoverage = [];
  if (manifest) {
    if (effectiveKind === 'native') validateNativeLibrary(root, files, manifest, properties, layout, errors, warnings);
    else if (effectiveKind === 'block') {
      validateBlockManifest(root, files, manifest, errors);
      migrations = validateMigrationManifest(root, files, manifest.id, errors);
      migrationCoverage = validateMigrationFixtures(root, files, migrations, manifest.version, errors);
    } else errors.push(`unsupported package kind: ${effectiveKind}`);
  }
  return {
    ok: errors.length === 0,
    kind: effectiveKind,
    root,
    files,
    manifest,
    properties,
    layout,
    migrations,
    migrationCoverage,
    warnings,
    errors,
  };
}

function runCli() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: node Validate-ImportablePackage.mjs <package-directory> [--kind native|block]');
    process.exitCode = 2;
    return;
  }
  const root = args[0];
  const kindIndex = args.indexOf('--kind');
  const kind = kindIndex >= 0 ? args[kindIndex + 1] : 'auto';
  const result = validateImportablePackage(root, { kind });
  if (!result.ok) {
    result.errors.forEach(error => console.error(`ERROR: ${error}`));
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify({
    status: 'passed',
    package_id: result.manifest.id,
    package_kind: result.kind,
    file_count: result.files.length,
    layout: result.layout.kind,
    source_count: result.layout.sources.length,
    migration_fixtures: result.migrationCoverage.length,
  }));
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) runCli();
