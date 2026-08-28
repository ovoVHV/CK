#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateBoardPackage } from './Validate-BoardPackage.mjs';
import {
  isSafePackagePath,
  listPackageFiles,
  validateImportablePackage,
} from './Validate-ImportablePackage.mjs';

export const CKPKG_VERSION = '1.0.0';
export const EXIT = Object.freeze({ OK: 0, CHECK_FAILED: 1, USAGE: 2, ENVIRONMENT: 3, IO: 4 });

const NEW_PACKAGE_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const PROFILE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const FQBN_RE = /^[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+(?::[A-Za-z0-9_.=-]+(?:,[A-Za-z0-9_.=-]+)*)?$/;
const TEXT_EXTENSIONS = new Set(['.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp', '.hxx', '.ino', '.json', '.md', '.properties', '.txt', '.xml']);
const MAX_REPORT_LOG_BYTES = 256 * 1024;
const MAX_PACKAGE_FILES = 4096;
const MAX_PACKAGE_FILE_BYTES = 32 * 1024 * 1024;
const MAX_PACKAGE_TOTAL_BYTES = 128 * 1024 * 1024;

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const slash = value => value.split(sep).join('/');
const ordinal = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const sha256 = value => createHash('sha256').update(value).digest('hex');

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function redactLocalText(value, packageRoot = null, repositoryRoot = null) {
  let output = String(value ?? '');
  const replacements = [
    [packageRoot, '<PACKAGE_ROOT>'],
    [repositoryRoot, '<CK_ROOT>'],
    [process.env.USERPROFILE ?? process.env.HOME, '<HOME>'],
    [process.env.TEMP ?? process.env.TMPDIR, '<TEMP>'],
  ].filter(([path]) => typeof path === 'string' && path.length > 2)
    .sort((left, right) => right[0].length - left[0].length);
  for (const [path, replacement] of replacements) {
    for (const variant of new Set([path, path.replaceAll('\\', '/'), path.replaceAll('/', '\\')])) {
      output = output.replace(new RegExp(escapeRegExp(variant), 'gi'), replacement);
    }
  }
  return output;
}

function help() {
  return `CK package developer CLI ${CKPKG_VERSION}

Usage:
  ckpkg --version [--json]
  ckpkg create <package-id> [--dir <parent>] [--template sensor-v2]
  ckpkg validate [package-dir] [--kind auto|board|block|native] [--core-version <semver>]
  ckpkg test [package-dir]
  ckpkg compile [package-dir] [profile] [--fqbn <fqbn> --example <path>]
  ckpkg compile <profile>                 # from a package root
  ckpkg pack [package-dir] [--out <zip>] [--force]

Global report options:
  --json                 Print one machine-readable JSON report to stdout.
  --output <path>        Atomically write the same JSON report to a file.
  -h, --help             Show this help.

Compile options:
  --arduino-cli <path>   Arduino CLI executable; otherwise CK_ARDUINO_CLI,
                         bundled CLI, then PATH are tried.
  --config <path>        Arduino CLI config; otherwise CK_ARDUINO_CONFIG or
                         the repository arduino-cli.yaml is used when present.
  --jobs <n>             Parallel compiler jobs (default: available CPU count).

Exit codes: 0 passed; 1 validation/test/compile failed; 2 usage/config error;
3 required tool/environment missing; 4 filesystem/package I/O failure.

Compile never uploads. A profile alias is accepted only when ckpkg.json maps it
to an explicit FQBN and package-relative sketch. Unknown aliases are rejected.`;
}

function parseArguments(argv) {
  const flags = new Map();
  const positional = [];
  const booleanFlags = new Set(['json', 'force', 'help', 'h', 'version']);
  const valueFlags = new Set([
    'output', 'dir', 'template', 'kind', 'core-version', 'fqbn', 'example',
    'arduino-cli', 'config', 'jobs', 'out',
  ]);
  const aliases = new Map([['o', 'output'], ['h', 'help']]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('-') || token === '-') {
      positional.push(token);
      continue;
    }
    const raw = token.replace(/^--?/, '');
    const equal = raw.indexOf('=');
    const rawName = equal >= 0 ? raw.slice(0, equal) : raw;
    const name = aliases.get(rawName) ?? rawName;
    if (booleanFlags.has(name)) {
      if (equal >= 0) throw usageError(`--${name} does not accept a value`);
      flags.set(name, true);
      continue;
    }
    if (!valueFlags.has(name) && equal < 0) {
      flags.set(name, true);
      continue;
    }
    const value = equal >= 0 ? raw.slice(equal + 1) : argv[++index];
    if (value === undefined || value.startsWith('--')) throw usageError(`--${name} requires a value`);
    flags.set(name, value);
  }
  return { positional, flags };
}

function assertAllowedFlags(flags, commandFlags) {
  const allowed = new Set(['json', 'output', 'help', ...commandFlags]);
  for (const name of flags.keys()) {
    if (!allowed.has(name)) throw usageError(`unknown option for this command: --${name}`);
  }
}

function usageError(message) {
  const error = new Error(message);
  error.exitCode = EXIT.USAGE;
  return error;
}

function ioError(message) {
  const error = new Error(message);
  error.exitCode = EXIT.IO;
  return error;
}

function environmentError(message) {
  const error = new Error(message);
  error.exitCode = EXIT.ENVIRONMENT;
  return error;
}

function readJson(path, label = path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    throw ioError(`${label} is not valid readable JSON: ${error.message}`);
  }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function atomicWrite(path, bytes, { force = true } = {}) {
  const target = resolve(path);
  mkdirSync(dirname(target), { recursive: true });
  if (!force && existsSync(target)) throw ioError(`output already exists (use --force): ${target}`);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  const backup = `${target}.${process.pid}.${Date.now()}.bak`;
  writeFileSync(temporary, bytes, { flag: 'wx' });
  let movedExisting = false;
  try {
    if (existsSync(target)) {
      renameSync(target, backup);
      movedExisting = true;
    }
    renameSync(temporary, target);
    if (movedExisting) rmSync(backup, { force: true });
  } catch (error) {
    rmSync(temporary, { force: true });
    if (movedExisting && !existsSync(target) && existsSync(backup)) renameSync(backup, target);
    throw ioError(`cannot atomically write ${target}: ${error.message}`);
  }
  return target;
}

function canonicalizePotentialPath(value) {
  let current = resolve(value);
  const suffix = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    suffix.unshift(basename(current));
    current = parent;
  }
  const canonicalBase = existsSync(current) ? realpathSync(current) : resolve(current);
  return resolve(canonicalBase, ...suffix);
}

function pathIsInside(rootValue, targetValue) {
  const contains = (root, target) => {
    const child = relative(root, target);
    return child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child));
  };
  const lexicalInside = contains(resolve(rootValue), resolve(targetValue));
  const canonicalInside = contains(canonicalizePotentialPath(rootValue), canonicalizePotentialPath(targetValue));
  return lexicalInside || canonicalInside;
}

function assertOutputOutsidePackage(report, outputPath) {
  if (!outputPath || !report.package_root_internal) return;
  if (pathIsInside(report.package_root_internal, outputPath)) {
    const error = usageError('report --output must be outside the package source directory');
    error.suppressOutput = true;
    throw error;
  }
}

function assertOutputOutsideRoot(root, outputPath) {
  if (!outputPath) return;
  if (pathIsInside(root, outputPath)) {
    const error = usageError('report --output must be outside the package source directory');
    error.suppressOutput = true;
    throw error;
  }
}

function pathsResolveToSameTarget(left, right) {
  const canonicalLeft = canonicalizePotentialPath(left);
  const canonicalRight = canonicalizePotentialPath(right);
  return process.platform === 'win32'
    ? canonicalLeft.toLocaleLowerCase('en-US') === canonicalRight.toLocaleLowerCase('en-US')
    : canonicalLeft === canonicalRight;
}

function resolvePackageRoot(value = '.') {
  const root = resolve(value);
  if (!existsSync(root)) throw ioError(`package directory does not exist: ${root}`);
  if (!statSync(root).isDirectory()) throw ioError(`package path is not a directory: ${root}`);
  return root;
}

function detectKind(root, requested = 'auto') {
  if (!['auto', 'board', 'block', 'native'].includes(requested)) {
    throw usageError(`unsupported package kind: ${requested}`);
  }
  if (requested !== 'auto') return requested;
  if (existsSync(join(root, 'board.json'))) return 'board';
  if (existsSync(join(root, 'library.json'))) {
    return existsSync(join(root, 'ck-blocks.json')) ? 'block' : 'native';
  }
  throw ioError(`no board.json or library.json found in package root: ${root}`);
}

function baseReport(command, status = 'passed') {
  return {
    schema_version: 1,
    tool: 'ckpkg',
    tool_version: CKPKG_VERSION,
    command,
    status,
    generated_at: new Date().toISOString(),
    certification_level: 'local-static',
    claims: {
      official_certification: false,
      publisher_signature_verified: false,
      hardware_tested: false,
    },
    package: null,
    checks: [],
    warnings: [],
    errors: [],
  };
}

function packageContentSha256(root, precomputedFiles) {
  const listing = precomputedFiles ? { files: precomputedFiles, errors: [] } : listPackageFiles(root);
  if (listing.errors.length > 0) return null;
  const hash = createHash('sha256');
  try {
    for (const path of [...listing.files].sort(ordinal)) {
      const bytes = readFileSync(join(root, ...path.split('/')));
      hash.update(path, 'utf8');
      hash.update(Buffer.from([0]));
      const length = Buffer.alloc(8);
      length.writeBigUInt64LE(BigInt(bytes.length));
      hash.update(length);
      hash.update(bytes);
    }
  } catch {
    return null;
  }
  return hash.digest('hex');
}

function preflightPackageRoot(root) {
  const listing = listPackageFiles(root);
  const errors = [...listing.errors];
  if (listing.files.length > MAX_PACKAGE_FILES) {
    errors.push(`package has ${listing.files.length} files; maximum is ${MAX_PACKAGE_FILES}`);
  }
  let totalBytes = 0;
  for (const path of listing.files) {
    try {
      const bytes = statSync(join(root, ...path.split('/'))).size;
      totalBytes += bytes;
      if (bytes > MAX_PACKAGE_FILE_BYTES) errors.push(`${path} exceeds the ${MAX_PACKAGE_FILE_BYTES}-byte file limit`);
    } catch (error) {
      errors.push(`cannot stat package file ${path}: ${error.message}`);
    }
  }
  if (totalBytes > MAX_PACKAGE_TOTAL_BYTES) {
    errors.push(`package is ${totalBytes} bytes; maximum is ${MAX_PACKAGE_TOTAL_BYTES}`);
  }
  if (!listing.files.includes('LICENSE')) errors.push('LICENSE is required');
  else if (!readFileSync(join(root, 'LICENSE'), 'utf8').trim()) errors.push('LICENSE must contain non-whitespace license text');
  if (listing.files.includes('.ck-quality-report.json')) errors.push('source package must not contain a stale .ck-quality-report.json');
  const contentSha256 = errors.length === 0 ? packageContentSha256(root, listing.files) : null;
  if (!contentSha256) errors.push('package content SHA-256 could not be produced from a safe stable file list');
  return { files: listing.files, totalBytes, contentSha256, errors: [...new Set(errors)] };
}

function packageIdentity(root, kind, manifest, contentSha256) {
  return {
    id: manifest?.id ?? null,
    version: manifest?.version ?? null,
    kind,
    root_name: basename(root),
    content_sha256: contentSha256,
  };
}

function staticChecklist(root, kind, manifest, validationPassed) {
  const checks = [{ id: 'schema-and-structure', status: validationPassed ? 'passed' : 'failed' }];
  const hasLicense = existsSync(join(root, 'LICENSE'));
  const declaredLicense = kind === 'board'
    ? typeof manifest?.license === 'string' && manifest.license.trim().length > 0
    : typeof manifest?.license === 'string' && manifest.license.trim().length > 0;
  checks.push({
    id: 'license-declaration',
    status: hasLicense && declaredLicense ? 'passed' : hasLicense ? 'warning' : 'failed',
    detail: hasLicense && !declaredLicense ? 'LICENSE exists, but the envelope has no SPDX declaration.' : undefined,
  });
  checks.push({
    id: 'dependency-declaration',
    status: kind === 'board' ? 'not_applicable' : 'passed',
    detail: kind === 'board' ? 'Board Core compatibility is checked separately.' : 'Dependency fields and cross-file declarations passed the package validator.',
  });
  checks.push({
    id: 'generator-contract',
    status: kind === 'block' ? (validationPassed ? 'passed' : 'failed') : 'not_applicable',
  });
  let schemaVersion = null;
  if (kind === 'block' && validationPassed && existsSync(join(root, 'ck-blocks.json'))) {
    schemaVersion = readJson(join(root, 'ck-blocks.json')).schema_version;
  }
  const boardPins = kind === 'board' && Array.isArray(manifest?.pins) ? manifest.pins : [];
  const boardPinsDetailed = boardPins.length > 0 && boardPins.every(pin => (
    isObject(pin)
    && Array.isArray(pin.aliases) && pin.aliases.length > 0
    && Array.isArray(pin.capabilities) && pin.capabilities.length > 0
    && typeof pin.sharing === 'string'
    && typeof pin.source === 'string' && pin.source.trim()
    && Array.isArray(pin.evidence) && pin.evidence.length > 0
  ));
  checks.push({
    id: 'hardware-resource-declaration',
    status: kind === 'block'
      ? (!validationPassed ? 'failed' : schemaVersion === 2 ? 'passed' : 'warning')
      : kind === 'board'
        ? (!validationPassed ? 'failed' : boardPinsDetailed ? 'passed' : 'warning')
        : 'not_applicable',
    detail: schemaVersion === 1
      ? 'v1 metadata is compatible but does not carry the complete v2 resource contract.'
      : kind === 'board' && boardPins.length === 0
        ? 'not_declared: no pin catalog is available.'
        : kind === 'board' && !boardPinsDetailed
          ? 'basic_only: aliases/capabilities/sharing/source/evidence are incomplete.'
          : undefined,
  });
  checks.push({
    id: 'ai-metadata',
    status: kind === 'block' ? (!validationPassed ? 'failed' : schemaVersion === 2 ? 'passed' : 'warning') : 'not_applicable',
    detail: schemaVersion === 1 ? 'Upgrade ck-blocks.json to schema_version 2 for full machine-readable semantics.' : undefined,
  });
  checks.push({
    id: 'example-compile',
    status: 'not_run',
    detail: 'Static validation does not claim compilation. Run ckpkg compile with an explicit profile or FQBN.',
  });
  const publisher = kind === 'board' ? manifest?.vendor : manifest?.author;
  checks.push({
    id: 'publisher-metadata',
    status: typeof publisher === 'string' && publisher.trim() && !/^todo$/i.test(publisher.trim()) ? 'passed' : 'warning',
    detail: 'Replace placeholder publisher metadata before distribution.',
  });
  return checks;
}

export function validatePackage(rootValue, options = {}) {
  const root = resolvePackageRoot(rootValue);
  const kind = detectKind(root, options.kind ?? 'auto');
  const report = baseReport('validate');
  Object.defineProperty(report, 'package_root_internal', { value: root, enumerable: false });
  const preflight = preflightPackageRoot(root);
  if (preflight.errors.length > 0) {
    let manifest = null;
    const manifestName = kind === 'board' ? 'board.json' : 'library.json';
    if (preflight.files.includes(manifestName)) {
      try { manifest = readJson(join(root, manifestName), manifestName); } catch { /* reported by the specific error below */ }
    }
    report.status = 'failed';
    report.package = packageIdentity(root, kind, manifest, null);
    report.errors = preflight.errors;
    report.summary = { file_count: preflight.files.length, total_bytes: preflight.totalBytes };
    report.checks = [{
      id: 'package-path-size-integrity',
      status: 'failed',
      detail: 'Safe file listing, non-empty LICENSE, size limits, and content hash are mandatory.',
    }];
    return report;
  }
  if (kind === 'board') {
    const result = validateBoardPackage(root, { actualCoreVersion: options.coreVersion });
    let manifest = null;
    if (result.valid && existsSync(join(root, 'board.json'))) manifest = readJson(join(root, 'board.json'));
    report.status = result.valid ? (result.warnings.length > 0 ? 'passed_with_warnings' : 'passed') : 'failed';
    report.package = packageIdentity(root, kind, manifest, preflight.contentSha256);
    report.warnings = result.warnings;
    report.errors = result.errors;
    report.summary = { ...result.counts, file_count: preflight.files.length, total_bytes: preflight.totalBytes };
    report.checks = staticChecklist(root, kind, manifest, result.valid);
  } else {
    const result = validateImportablePackage(root, { kind });
    report.status = result.ok ? (result.warnings.length > 0 ? 'passed_with_warnings' : 'passed') : 'failed';
    report.package = packageIdentity(root, kind, result.manifest, preflight.contentSha256);
    report.warnings = result.warnings;
    report.errors = result.errors;
    report.summary = {
      file_count: result.files.length,
      arduino_layout: result.layout.kind,
      recursive_source_count: result.layout.sources.length,
      migration_fixture_count: result.migrationCoverage.length,
      total_bytes: preflight.totalBytes,
    };
    report.checks = staticChecklist(root, kind, result.manifest, result.ok);
  }
  report.checks.unshift({
    id: 'package-path-size-integrity',
    status: 'passed',
    detail: `${preflight.files.length} files; ${preflight.totalBytes} bytes; SHA-256 ${preflight.contentSha256}`,
  });
  if (existsSync(join(root, 'ckpkg.json'))) {
    const config = validateCkpkgConfig(root);
    const configErrors = config.errors ?? [];
    report.checks.push({
      id: 'compile-profile-contract',
      status: configErrors.length > 0 ? 'failed' : 'passed',
      detail: `${config.profiles.length} explicit compile profile(s)`,
    });
    report.warnings.push(...config.warnings);
    report.errors.push(...configErrors);
    if (configErrors.length > 0) report.status = 'failed';
  } else {
    report.checks.push({
      id: 'compile-profile-contract',
      status: 'not_applicable',
      detail: 'ckpkg.json is optional for import; --fqbn and --example remain available to developers.',
    });
  }
  for (const check of report.checks) {
    if (check.status === 'warning' && check.detail && !report.warnings.includes(check.detail)) {
      report.warnings.push(check.detail);
    }
  }
  if (!report.package.content_sha256 || report.checks.some(check => check.status === 'failed') || report.errors.length > 0) {
    report.status = 'failed';
  }
  if (report.status !== 'failed' && report.warnings.length > 0) report.status = 'passed_with_warnings';
  return report;
}

function validateCkpkgConfig(root) {
  const path = join(root, 'ckpkg.json');
  if (!existsSync(path)) return { profiles: [], warnings: ['ckpkg.json is absent; use --fqbn and --example for compile.'] };
  const errors = [];
  let value;
  try {
    value = readJson(path, 'ckpkg.json');
  } catch (error) {
    return { profiles: [], warnings: [], errors: [error.message] };
  }
  const allowedRoot = new Set(['schema_version', 'compile_profiles']);
  if (!isObject(value)) errors.push('ckpkg.json must be an object');
  else {
    for (const key of Object.keys(value)) if (!allowedRoot.has(key)) errors.push(`ckpkg.json.${key} is not allowed`);
    if (value.schema_version !== 1) errors.push('ckpkg.json.schema_version must be 1');
    if (!Array.isArray(value.compile_profiles) || value.compile_profiles.length === 0 || value.compile_profiles.length > 32) {
      errors.push('ckpkg.json.compile_profiles must contain 1..32 profiles');
    }
  }
  const profiles = [];
  const ids = new Set();
  for (const [index, profile] of (value?.compile_profiles ?? []).entries()) {
    const label = `ckpkg.json.compile_profiles[${index}]`;
    if (!isObject(profile)) {
      errors.push(`${label} must be an object`);
      continue;
    }
    const allowed = new Set(['id', 'fqbn', 'sketch', 'description']);
    for (const key of Object.keys(profile)) if (!allowed.has(key)) errors.push(`${label}.${key} is not allowed`);
    if (!PROFILE_ID_RE.test(profile.id ?? '')) errors.push(`${label}.id is invalid`);
    else if (ids.has(profile.id)) errors.push(`${label}.id is duplicated`);
    else ids.add(profile.id);
    if (!FQBN_RE.test(profile.fqbn ?? '')) errors.push(`${label}.fqbn must be an explicit FQBN`);
    if (!isSafePackagePath(profile.sketch ?? '')) errors.push(`${label}.sketch is not a safe package path`);
    else {
      const sketchPath = join(root, ...profile.sketch.split('/'));
      if (!existsSync(sketchPath)) errors.push(`${label}.sketch does not exist: ${profile.sketch}`);
    }
    if (profile.description !== undefined && (typeof profile.description !== 'string' || profile.description.length > 512)) {
      errors.push(`${label}.description must be a string no longer than 512 characters`);
    }
    profiles.push(profile);
  }
  return { profiles, warnings: [], errors };
}

function jsonPointerGet(value, pointer) {
  if (pointer === '') return value;
  if (typeof pointer !== 'string' || !pointer.startsWith('/')) throw new Error('JSON pointer must start with /');
  return pointer.slice(1).split('/').reduce((current, token) => {
    const key = token.replaceAll('~1', '/').replaceAll('~0', '~');
    if ((isObject(current) || Array.isArray(current)) && own(current, key)) return current[key];
    throw new Error(`JSON pointer segment does not exist: ${key}`);
  }, value);
}

function runDeclaredTests(root) {
  const path = join(root, 'tests', 'ckpkg-tests.json');
  if (!existsSync(path)) return {
    checks: [],
    warnings: ['tests/ckpkg-tests.json is absent; only built-in structural and generator checks ran.'],
    errors: [],
  };
  const errors = [];
  const checks = [];
  let manifest;
  try {
    manifest = readJson(path, 'tests/ckpkg-tests.json');
  } catch (error) {
    return { checks, warnings: [], errors: [error.message] };
  }
  if (!isObject(manifest) || manifest.schema_version !== 1 || !Array.isArray(manifest.checks)) {
    return { checks, warnings: [], errors: ['tests/ckpkg-tests.json must be a schema_version 1 object with checks[]'] };
  }
  if (manifest.checks.length === 0 || manifest.checks.length > 128) {
    errors.push('tests/ckpkg-tests.json must declare 1..128 checks');
  }
  const ids = new Set();
  for (const [index, check] of manifest.checks.entries()) {
    const label = `tests/ckpkg-tests.json.checks[${index}]`;
    let status = 'failed';
    let detail = '';
    try {
      if (!isObject(check)) throw new Error(`${label} must be an object`);
      if (!PROFILE_ID_RE.test(check.id ?? '') || ids.has(check.id)) throw new Error(`${label}.id is invalid or duplicated`);
      ids.add(check.id);
      if (!['file-exists', 'file-contains', 'json-pointer-equals'].includes(check.kind)) throw new Error(`${label}.kind is unsupported`);
      if (!isSafePackagePath(check.path ?? '')) throw new Error(`${label}.path is unsafe`);
      const target = join(root, ...check.path.split('/'));
      if (!existsSync(target) || !statSync(target).isFile()) throw new Error(`missing file: ${check.path}`);
      if (check.kind === 'file-exists') {
        if (Object.keys(check).some(key => !['id', 'kind', 'path'].includes(key))) throw new Error(`${label} has unknown fields`);
      } else if (check.kind === 'file-contains') {
        if (Object.keys(check).some(key => !['id', 'kind', 'path', 'text'].includes(key))) throw new Error(`${label} has unknown fields`);
        if (typeof check.text !== 'string' || check.text.length === 0 || check.text.length > 4096) throw new Error(`${label}.text is invalid`);
        if (!readFileSync(target, 'utf8').includes(check.text)) throw new Error(`${check.path} does not contain the expected text`);
      } else {
        if (Object.keys(check).some(key => !['id', 'kind', 'path', 'pointer', 'equals'].includes(key))) throw new Error(`${label} has unknown fields`);
        const actual = jsonPointerGet(readJson(target, check.path), check.pointer);
        if (JSON.stringify(actual) !== JSON.stringify(check.equals)) throw new Error(`JSON pointer ${check.pointer} did not equal the expected value`);
      }
      status = 'passed';
      detail = `${check.kind}: ${check.path}`;
    } catch (error) {
      detail = error.message;
      errors.push(`${check.id ?? label}: ${error.message}`);
    }
    checks.push({ id: check?.id ?? `invalid-${index}`, status, detail });
  }
  return { checks, warnings: [], errors };
}

export function testPackage(rootValue, options = {}) {
  const root = resolvePackageRoot(rootValue);
  const validation = validatePackage(root, options);
  const report = { ...validation, command: 'test', checks: [...validation.checks] };
  Object.defineProperty(report, 'package_root_internal', { value: root, enumerable: false });
  const config = validateCkpkgConfig(root);
  const declared = runDeclaredTests(root);
  report.checks.push(...declared.checks.map(check => ({ ...check, id: `declared:${check.id}` })));
  report.warnings = [...report.warnings, ...config.warnings, ...declared.warnings];
  report.errors = [...report.errors, ...declared.errors];
  if (report.errors.length > 0) report.status = 'failed';
  else if (report.warnings.length > 0) report.status = 'passed_with_warnings';
  else report.status = 'passed';
  report.test_summary = {
    built_in_validation: validation.status !== 'failed',
    compile_profiles: config.profiles.length,
    declared_checks: declared.checks.length,
    declared_passed: declared.checks.filter(check => check.status === 'passed').length,
    compilation_performed: false,
  };
  return report;
}

function findRepositoryRoot() {
  let current = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(current, 'Cargo.toml')) && existsSync(join(current, 'apps'))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

export function resolveArduinoCli(options = {}) {
  const packageRoot = options.packageRoot ? resolve(options.packageRoot) : null;
  const environment = options.environment ?? process.env;
  const repositoryRoot = own(options, 'repositoryRoot') ? options.repositoryRoot : findRepositoryRoot();
  const executableName = process.platform === 'win32' ? 'arduino-cli.exe' : 'arduino-cli';
  const resolveDeclared = (value, source) => {
    const path = resolve(value);
    if (!existsSync(path) || !statSync(path).isFile()) {
      throw environmentError(`${source} Arduino CLI does not exist or is not a file: ${basename(path)}`);
    }
    const canonical = realpathSync(path);
    return {
      path: canonical,
      source,
      trust: source === 'ck-bundled' ? 'bundled-local-identity' : `${source}-untrusted`,
    };
  };
  if (options.explicit) return resolveDeclared(options.explicit, 'explicit');
  if (environment.CK_ARDUINO_CLI) return resolveDeclared(environment.CK_ARDUINO_CLI, 'environment');
  if (repositoryRoot) {
    const bundled = join(repositoryRoot, 'apps', 'desktop', 'src-tauri', 'bin', executableName);
    if (existsSync(bundled) && statSync(bundled).isFile()) return resolveDeclared(bundled, 'ck-bundled');
  }
  const separator = process.platform === 'win32' ? ';' : ':';
  for (const rawDirectory of String(environment.PATH ?? '').split(separator)) {
    if (!rawDirectory.trim()) continue;
    const directory = canonicalizePotentialPath(rawDirectory.replace(/^"|"$/g, ''));
    const candidate = join(directory, executableName);
    if (!existsSync(candidate) || !statSync(candidate).isFile()) continue;
    const canonical = realpathSync(candidate);
    if (packageRoot && pathIsInside(packageRoot, canonical)) continue;
    return { path: canonical, source: 'path', trust: 'path-untrusted' };
  }
  throw environmentError(`Arduino CLI not found in a safe absolute PATH entry; set --arduino-cli or CK_ARDUINO_CLI`);
}

function probeArduinoCliIdentity(descriptor) {
  const executableSha256 = sha256(readFileSync(descriptor.path));
  const result = spawnSync(
    descriptor.path,
    ['version', '--format', 'json', '--no-color'],
    { cwd: dirname(descriptor.path), encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, windowsHide: true },
  );
  const stdout = result.stdout ?? '';
  let reportedVersion = null;
  if (result.status === 0) {
    try {
      const value = JSON.parse(stdout);
      reportedVersion = value.VersionString ?? value.version ?? value.Version ?? null;
    } catch {
      reportedVersion = /\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/.exec(stdout)?.[0] ?? null;
    }
  }
  return {
    source: descriptor.source,
    trust: descriptor.trust,
    executable_name: basename(descriptor.path),
    executable_sha256: executableSha256,
    reported_version: typeof reportedVersion === 'string' ? reportedVersion : null,
    version_evidence: 'self-reported-by-local-executable',
    version_probe_exit_code: result.status,
  };
}

function discoverArduinoToolBinDirectories(cli, configPath) {
  const args = ['config', 'dump', '--json', '--no-color'];
  if (configPath) args.push('--config-file', configPath);
  const result = spawnSync(cli, args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, windowsHide: true });
  if (result.status !== 0 || !result.stdout) return [];
  let dataRoot;
  try {
    dataRoot = JSON.parse(result.stdout)?.config?.directories?.data;
  } catch {
    return [];
  }
  if (typeof dataRoot !== 'string' || !dataRoot.trim()) return [];
  const toolsRoot = join(resolve(dataRoot), 'packages');
  if (!existsSync(toolsRoot)) return [];
  const bins = [];
  const visit = (directory, depth) => {
    if (depth > 6 || bins.length >= 128) return;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const child = join(directory, entry.name);
      if (entry.name.toLowerCase() === 'bin') bins.push(child);
      else visit(child, depth + 1);
    }
  };
  visit(toolsRoot, 0);
  return [...new Set(bins)].sort(ordinal);
}

function resolveSketch(root, value) {
  if (!value) throw usageError('compile requires a profile or --example <package-relative sketch>');
  if (!isSafePackagePath(value)) throw usageError(`sketch path must be package-relative and safe: ${value}`);
  const path = join(root, ...value.split('/'));
  if (!existsSync(path)) throw ioError(`sketch does not exist: ${value}`);
  const stat = statSync(path);
  if (stat.isDirectory()) {
    const expected = join(path, `${basename(path)}.ino`);
    if (!existsSync(expected)) throw ioError(`Arduino sketch directory must contain ${basename(path)}.ino`);
    return path;
  }
  if (!stat.isFile() || extname(path).toLowerCase() !== '.ino') throw usageError('sketch must be an .ino file or Arduino sketch directory');
  if (basename(path, '.ino') !== basename(dirname(path))) throw usageError('Arduino .ino filename must match its containing directory');
  return dirname(path);
}

export function compilePackage(rootValue, options = {}) {
  const root = resolvePackageRoot(rootValue);
  assertOutputOutsideRoot(root, options.reportOutput);
  const validation = validatePackage(root, { kind: options.kind ?? 'auto' });
  const report = { ...validation, command: 'compile', checks: [...validation.checks] };
  Object.defineProperty(report, 'package_root_internal', { value: root, enumerable: false });
  if (validation.status === 'failed') return report;
  const config = validateCkpkgConfig(root);
  if ((config.errors ?? []).length > 0) {
    report.status = 'failed';
    report.errors.push(...config.errors);
    return report;
  }
  let profile = null;
  if (options.profile) {
    if (options.fqbn || options.example) throw usageError('do not override --fqbn or --example when selecting a declared profile');
    profile = config.profiles.find(item => item.id === options.profile);
    if (!profile) throw usageError(`unknown compile profile '${options.profile}'; declare it in ckpkg.json or use --fqbn and --example`);
  }
  const fqbn = options.fqbn ?? profile?.fqbn;
  const sketchValue = options.example ?? profile?.sketch;
  if (!FQBN_RE.test(fqbn ?? '')) throw usageError('compile requires an explicit valid --fqbn or ckpkg.json profile FQBN');
  const sketch = resolveSketch(root, sketchValue);
  const repo = findRepositoryRoot();
  const cliDescriptor = resolveArduinoCli({
    explicit: options.arduinoCli,
    packageRoot: root,
    repositoryRoot: repo,
  });
  const cli = cliDescriptor.path;
  const cliIdentity = probeArduinoCliIdentity(cliDescriptor);
  const configPath = options.config
    ? resolve(options.config)
    : process.env.CK_ARDUINO_CONFIG
      ? resolve(process.env.CK_ARDUINO_CONFIG)
      : repo && existsSync(join(repo, 'arduino-cli.yaml')) ? join(repo, 'arduino-cli.yaml') : null;
  if (configPath && !existsSync(configPath)) throw environmentError(`Arduino CLI config does not exist: ${configPath}`);
  const jobs = options.jobs === undefined ? 0 : Number(options.jobs);
  if (!Number.isInteger(jobs) || jobs < 0 || jobs > 256) throw usageError('--jobs must be an integer from 0 to 256');
  const args = ['compile', '--fqbn', fqbn];
  if (validation.package.kind === 'board') {
    const boardLibraries = join(root, 'libraries');
    if (existsSync(boardLibraries)) args.push('--libraries', boardLibraries);
  } else args.push('--library', root);
  args.push('--jobs', String(jobs), '--no-color');
  if (configPath) args.push('--config-file', configPath);
  args.push(sketch);
  const toolBins = discoverArduinoToolBinDirectories(cli, configPath);
  const childEnvironment = {
    ...process.env,
    PATH: [...toolBins, process.env.PATH ?? ''].filter(Boolean).join(process.platform === 'win32' ? ';' : ':'),
  };
  const started = Date.now();
  const result = spawnSync(cli, args, {
    cwd: root,
    encoding: 'utf8',
    env: childEnvironment,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  const durationMs = Date.now() - started;
  if (result.error?.code === 'ENOENT') throw environmentError(`Arduino CLI not found; set --arduino-cli or CK_ARDUINO_CLI (${cli})`);
  if (result.error) throw environmentError(`Arduino CLI could not start: ${result.error.message}`);
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  const finalContentSha256 = packageContentSha256(root);
  const packageStable = Boolean(finalContentSha256) && finalContentSha256 === validation.package.content_sha256;
  const passed = result.status === 0 && packageStable;
  report.status = passed ? (report.warnings.length > 0 ? 'passed_with_warnings' : 'passed') : 'failed';
  report.compile = {
    performed: true,
    upload_performed: false,
    profile: profile?.id ?? null,
    fqbn,
    sketch: slash(relative(root, sketch)),
    arduino_cli: cliIdentity,
    config: configPath ? {
      source: options.config ? 'explicit' : process.env.CK_ARDUINO_CONFIG ? 'environment' : 'repository-default',
      file_name: basename(configPath),
    } : null,
    toolchain_path_entries: toolBins.length,
    exit_code: result.status,
    duration_ms: durationMs,
    stdout_sha256: sha256(stdout),
    stderr_sha256: sha256(stderr),
    stdout: redactLocalText(stdout.slice(-MAX_REPORT_LOG_BYTES), root, repo),
    stderr: redactLocalText(stderr.slice(-MAX_REPORT_LOG_BYTES), root, repo),
    package_content: {
      before_sha256: validation.package.content_sha256,
      after_sha256: finalContentSha256,
      stable: packageStable,
    },
  };
  report.checks = report.checks.map(check => check.id === 'example-compile'
    ? { id: 'example-compile', status: passed ? 'passed' : 'failed', detail: `${fqbn}; ${durationMs} ms` }
    : check);
  if (result.status !== 0) report.errors.push(`Arduino CLI compile exited with code ${result.status}`);
  if (!packageStable) {
    report.errors.push('package content changed during compile; the compile result is not publishable evidence');
    report.checks.push({ id: 'package-content-stable', status: 'failed', detail: 'Content SHA-256 changed during the compile window.' });
  } else report.checks.push({ id: 'package-content-stable', status: 'passed', detail: finalContentSha256 });
  return report;
}

function crc32Table() {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xEDB88320 ^ (value >>> 1)) : (value >>> 1);
    table[index] = value >>> 0;
  }
  return table;
}

const CRC32_TABLE = crc32Table();
function crc32(buffer) {
  let value = 0xFFFFFFFF;
  for (const byte of buffer) value = CRC32_TABLE[(value ^ byte) & 0xFF] ^ (value >>> 8);
  return (value ^ 0xFFFFFFFF) >>> 0;
}

function zipUInt16(value) {
  const output = Buffer.alloc(2);
  output.writeUInt16LE(value, 0);
  return output;
}

function zipUInt32(value) {
  const output = Buffer.alloc(4);
  output.writeUInt32LE(value >>> 0, 0);
  return output;
}

export function buildDeterministicZip(rootValue) {
  const root = resolvePackageRoot(rootValue);
  const listing = listPackageFiles(root);
  if (listing.errors.length > 0) throw ioError(listing.errors.join('; '));
  const packageRoot = basename(root);
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const relativePath of listing.files.sort(ordinal)) {
    const data = readFileSync(join(root, ...relativePath.split('/')));
    if (data.length > 0xFFFFFFFF) throw ioError(`ZIP entry exceeds 4 GiB: ${relativePath}`);
    const name = Buffer.from(`${packageRoot}/${relativePath}`, 'utf8');
    const checksum = crc32(data);
    const local = Buffer.concat([
      zipUInt32(0x04034B50), zipUInt16(20), zipUInt16(0x0800), zipUInt16(0),
      zipUInt16(0), zipUInt16(33), zipUInt32(checksum), zipUInt32(data.length),
      zipUInt32(data.length), zipUInt16(name.length), zipUInt16(0), name, data,
    ]);
    const central = Buffer.concat([
      zipUInt32(0x02014B50), zipUInt16(20), zipUInt16(20), zipUInt16(0x0800),
      zipUInt16(0), zipUInt16(0), zipUInt16(33), zipUInt32(checksum),
      zipUInt32(data.length), zipUInt32(data.length), zipUInt16(name.length),
      zipUInt16(0), zipUInt16(0), zipUInt16(0), zipUInt16(0), zipUInt32(0),
      zipUInt32(offset), name,
    ]);
    localParts.push(local);
    centralParts.push(central);
    offset += local.length;
  }
  if (listing.files.length > 0xFFFF) throw ioError('ZIP64 is not supported; package has more than 65535 files');
  const central = Buffer.concat(centralParts);
  const end = Buffer.concat([
    zipUInt32(0x06054B50), zipUInt16(0), zipUInt16(0), zipUInt16(listing.files.length),
    zipUInt16(listing.files.length), zipUInt32(central.length), zipUInt32(offset), zipUInt16(0),
  ]);
  return Buffer.concat([...localParts, central, end]);
}

export function packPackage(rootValue, options = {}) {
  const root = resolvePackageRoot(rootValue);
  assertOutputOutsideRoot(root, options.reportOutput);
  const validation = testPackage(root, { kind: options.kind ?? 'auto' });
  const report = { ...validation, command: 'pack', checks: [...validation.checks] };
  Object.defineProperty(report, 'package_root_internal', { value: root, enumerable: false });
  if (validation.status === 'failed') return report;
  const manifest = validation.package;
  const output = resolve(options.output ?? join(dirname(root), `${manifest.id}-${manifest.version}.zip`));
  if (options.reportOutput && pathsResolveToSameTarget(output, options.reportOutput)) {
    const error = usageError('pack --out and report --output must be different files');
    error.suppressOutput = true;
    throw error;
  }
  if (pathIsInside(root, output)) {
    throw usageError('pack output must be outside the package source directory');
  }
  const beforeArchiveSha256 = packageContentSha256(root);
  if (!beforeArchiveSha256 || beforeArchiveSha256 !== manifest.content_sha256) {
    report.status = 'failed';
    report.errors.push('package content changed after validation and before archive creation');
    report.checks.push({ id: 'package-content-stable', status: 'failed', detail: 'Pre-archive content SHA-256 mismatch.' });
    return report;
  }
  const bytes = buildDeterministicZip(root);
  const afterArchiveSha256 = packageContentSha256(root);
  if (!afterArchiveSha256 || afterArchiveSha256 !== beforeArchiveSha256) {
    report.status = 'failed';
    report.errors.push('package content changed while the archive was being created; no ZIP was published');
    report.checks.push({ id: 'package-content-stable', status: 'failed', detail: 'Post-archive content SHA-256 mismatch.' });
    return report;
  }
  atomicWrite(output, bytes, { force: Boolean(options.force) });
  const afterPublishSha256 = packageContentSha256(root);
  if (!afterPublishSha256 || afterPublishSha256 !== beforeArchiveSha256) {
    rmSync(output, { force: true });
    report.status = 'failed';
    report.errors.push('package content changed during archive publication; the new ZIP was removed');
    report.checks.push({ id: 'package-content-stable', status: 'failed', detail: 'Post-publication content SHA-256 mismatch.' });
    return report;
  }
  report.artifact = { file_name: basename(output), bytes: bytes.length, sha256: sha256(bytes), deterministic_timestamp: '1980-01-01T00:00:00Z' };
  report.checks.push({ id: 'package-content-stable', status: 'passed', detail: afterPublishSha256 });
  report.checks.push({ id: 'deterministic-package-archive', status: 'passed', detail: report.artifact.sha256 });
  return report;
}

function generatedNativeNames(codeId) {
  return {
    publicBase: `${codeId}_sensor`,
    mathBase: `${codeId}_sensor_math`,
    codecBase: `${codeId}_sensor_codec`,
  };
}

function generatedTemplatePath(relativePath, codeId) {
  const names = generatedNativeNames(codeId);
  const remapped = new Map([
    ['src/CKExampleSensor.h', `src/${names.publicBase}.h`],
    ['src/CKExampleSensor.cpp', `src/${names.publicBase}.cpp`],
    ['src/CKExampleSensorMath.c', `src/${names.mathBase}.c`],
    ['src/internal/CKExampleSensorCodec.h', `src/internal/${names.codecBase}.h`],
    ['src/internal/CKExampleSensorCodec.c', `src/internal/${names.codecBase}.c`],
  ]);
  return remapped.get(relativePath) ?? relativePath;
}

function replaceTextInTemplate(text, codeId) {
  const names = generatedNativeNames(codeId);
  return text
    .replaceAll('CKExampleSensorCodec', names.codecBase)
    .replaceAll('CKExampleSensorMath', names.mathBase)
    .replaceAll('CKExampleSensor', names.publicBase)
    .replaceAll('ckExample', `${codeId}_`)
    .replaceAll('ck_example_', `${codeId}_`);
}

export function createPackage(packageId, options = {}) {
  if (!NEW_PACKAGE_ID_RE.test(packageId ?? '')) {
    throw usageError('new package-id must match [a-z0-9][a-z0-9._-]{0,127} (canonical lowercase)');
  }
  if ((options.template ?? 'sensor-v2') !== 'sensor-v2') throw usageError('only the sensor-v2 template is available in this SDK version');
  const parent = resolve(options.directory ?? '.');
  const target = join(parent, packageId);
  if (existsSync(target)) throw ioError(`target already exists: ${target}`);
  const repo = findRepositoryRoot();
  const template = options.templateRoot
    ? resolve(options.templateRoot)
    : repo
      ? join(repo, 'examples', 'importable-packages', 'ck_example_i2c_sensor_v2')
      : join(dirname(dirname(fileURLToPath(import.meta.url))), 'examples', 'importable-packages', 'ck_example_i2c_sensor_v2');
  if (!existsSync(template)) throw environmentError(`sensor-v2 template is not available: ${template}`);
  const codeSlug = packageId.replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_').slice(0, 64);
  const codeId = `ckp_${codeSlug}_${sha256(Buffer.from(packageId, 'utf8')).slice(0, 12)}`;
  const listing = listPackageFiles(template);
  if (listing.errors.length > 0) throw ioError(listing.errors.join('; '));
  mkdirSync(target, { recursive: false });
  try {
    for (const relativePath of listing.files) {
      if (relativePath === 'ck-migrations.json' || relativePath.startsWith('migration-fixtures/')) continue;
      const source = join(template, ...relativePath.split('/'));
      let destinationRelative = generatedTemplatePath(relativePath, codeId);
      if (relativePath === 'blocks/ck-generator.json') destinationRelative = 'generator/ck-generator.json';
      const destination = join(target, ...destinationRelative.split('/'));
      mkdirSync(dirname(destination), { recursive: true });
      if (TEXT_EXTENSIONS.has(extname(source).toLowerCase()) || basename(source) === 'library.properties' || basename(source) === 'LICENSE') {
        const text = replaceTextInTemplate(readFileSync(source, 'utf8'), codeId);
        writeFileSync(destination, text, 'utf8');
      } else copyFileSync(source, destination);
    }
    const library = readJson(join(target, 'library.json'));
    library.id = packageId;
    library.name = `${packageId} CK extension`;
    library.version = '0.1.0';
    library.description = 'Created by ckpkg from the auditable v2 declarative sensor template.';
    library.author = 'TODO';
    writeJson(join(target, 'library.json'), library);

    const blockManifest = readJson(join(target, 'ck-blocks.json'));
    blockManifest.id = packageId;
    blockManifest.display_name = `${packageId} blocks`;
    blockManifest.entrypoints.generator = 'generator/ck-generator.json';
    writeJson(join(target, 'ck-blocks.json'), blockManifest);

    const propertiesPath = join(target, 'library.properties');
    let properties = readFileSync(propertiesPath, 'utf8');
    properties = properties.replace(/^name=.*$/m, `name=${packageId}`).replace(/^version=.*$/m, 'version=0.1.0');
    properties = properties.replace(/^author=.*$/m, 'author=TODO').replace(/^maintainer=.*$/m, 'maintainer=TODO');
    writeFileSync(propertiesPath, properties, 'utf8');

    writeJson(join(target, 'ckpkg.json'), {
      schema_version: 1,
      compile_profiles: [
        {
          id: 'esp32-c6',
          fqbn: 'esp32:esp32:esp32c6:JTAGAdapter=default,CDCOnBoot=default,PartitionScheme=default,CPUFreq=160,FlashMode=qio,FlashFreq=80,FlashSize=4M,UploadSpeed=921600,DebugLevel=none,EraseFlash=none,ZigbeeMode=default',
          sketch: 'examples/serial_temperature',
          description: 'Explicit template profile; review FQBN options for your actual board before publishing.',
        },
        {
          id: 'arduino-nano',
          fqbn: 'arduino:avr:nano:cpu=atmega328old',
          sketch: 'examples/serial_temperature',
          description: 'Explicit AVR compile-only profile.',
        },
      ],
    });
    writeJson(join(target, 'tests', 'ckpkg-tests.json'), {
      schema_version: 1,
      checks: [
        { id: 'example-sketch', kind: 'file-contains', path: 'examples/serial_temperature/serial_temperature.ino', text: `#include <${generatedNativeNames(codeId).publicBase}.h>` },
        { id: 'deep-c-source', kind: 'file-exists', path: `src/internal/${generatedNativeNames(codeId).codecBase}.c` },
        { id: 'v2-ai-contract', kind: 'json-pointer-equals', path: 'ck-blocks.json', pointer: '/schema_version', equals: 2 },
        { id: 'declarative-generator', kind: 'json-pointer-equals', path: 'generator/ck-generator.json', pointer: '/schema', equals: 'ck-generator' },
      ],
    });
    writeFileSync(join(target, 'README.md'), `# ${packageId}\n\nGenerated by ckpkg from CK's v2 declarative sensor template.\n\n- Edit library.json and ck-blocks.json metadata.\n- Keep native Arduino sources under recursive src/.\n- Keep generator rules declarative JSON; JavaScript entrypoints are not executed.\n- Run: node path/to/ckpkg.mjs validate .\n- Run: node path/to/ckpkg.mjs test .\n- Run: node path/to/ckpkg.mjs compile esp32-c6\n- Run: node path/to/ckpkg.mjs pack .\n\nThe included compile profiles are explicit template examples, not hardware certification. Review the full FQBN before publishing.\n`, 'utf8');
    const test = testPackage(target);
    if (test.status === 'failed') throw ioError(`generated template failed its own gate: ${test.errors.join('; ')}`);
    const report = baseReport('create', test.status);
    Object.defineProperty(report, 'package_root_internal', { value: target, enumerable: false });
    report.package = test.package;
    report.checks = test.checks;
    report.warnings = test.warnings;
    report.created = { root_name: basename(target), template: 'sensor-v2', compile_profiles: ['esp32-c6', 'arduino-nano'] };
    return report;
  } catch (error) {
    rmSync(target, { recursive: true, force: true });
    throw error;
  }
}

function printHuman(report) {
  const label = report.status === 'failed' ? 'FAIL' : report.status === 'passed_with_warnings' ? 'WARN' : 'PASS';
  console.log(`[${label}] ckpkg ${report.command}${report.package?.id ? `: ${report.package.id}` : ''}`);
  for (const check of report.checks ?? []) console.log(`  ${check.status.padEnd(14)} ${check.id}${check.detail ? ` — ${check.detail}` : ''}`);
  for (const warning of report.warnings ?? []) console.warn(`  warning: ${warning}`);
  for (const error of report.errors ?? []) console.error(`  error: ${error}`);
  if (report.artifact) console.log(`  archive: ${report.artifact.file_name}\n  sha256: ${report.artifact.sha256}`);
  if (report.compile?.performed) console.log(`  compile: ${report.compile.fqbn}; ${report.compile.duration_ms} ms; exit ${report.compile.exit_code}`);
  if (report.compile?.performed && report.compile.exit_code !== 0) {
    if (report.compile.stdout) console.error(`\n${report.compile.stdout}`);
    if (report.compile.stderr) console.error(`\n${report.compile.stderr}`);
  }
}

function publicReport(report) {
  const packageRoot = report.package_root_internal ?? null;
  const repositoryRoot = findRepositoryRoot();
  const visit = value => {
    if (typeof value === 'string') return redactLocalText(value, packageRoot, repositoryRoot);
    if (Array.isArray(value)) return value.map(visit);
    if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, visit(entry)]));
    return value;
  };
  return visit(report);
}

function emitReport(report, flags) {
  const output = publicReport(report);
  if (flags.get('output')) atomicWrite(flags.get('output'), Buffer.from(`${JSON.stringify(output, null, 2)}\n`), { force: true });
  if (flags.get('json')) console.log(JSON.stringify(output));
  else printHuman(output);
}

export function run(argv = process.argv.slice(2)) {
  let parsed;
  let activeCommand = 'unknown';
  try {
    parsed = parseArguments(argv);
    const { positional, flags } = parsed;
    if (flags.get('version')) {
      const unsupported = [...flags.keys()].filter(name => !['version', 'json', 'output'].includes(name));
      if (unsupported.length > 0 || positional.length > 0) {
        throw usageError('--version does not accept a command or command options');
      }
      const versionReport = {
        schema_version: 1,
        tool: 'ckpkg',
        tool_version: CKPKG_VERSION,
      };
      if (flags.get('output')) {
        atomicWrite(
          flags.get('output'),
          Buffer.from(`${JSON.stringify(versionReport, null, 2)}\n`),
          { force: true },
        );
      }
      if (flags.get('json')) console.log(JSON.stringify(versionReport));
      else console.log(`ckpkg ${CKPKG_VERSION}`);
      return EXIT.OK;
    }
    if (flags.get('help') || positional.length === 0) {
      console.log(help());
      return EXIT.OK;
    }
    const command = positional.shift();
    activeCommand = command;
    let report;
    if (command === 'create') {
      assertAllowedFlags(flags, ['dir', 'template']);
      if (positional.length !== 1) throw usageError('create requires exactly one package-id');
      assertOutputOutsideRoot(join(resolve(flags.get('dir') ?? '.'), positional[0]), flags.get('output'));
      report = createPackage(positional[0], { directory: flags.get('dir'), template: flags.get('template') });
    } else if (command === 'validate') {
      assertAllowedFlags(flags, ['kind', 'core-version']);
      if (positional.length > 1) throw usageError('validate accepts at most one package directory');
      const root = positional[0] ?? '.';
      assertOutputOutsideRoot(root, flags.get('output'));
      report = validatePackage(root, { kind: flags.get('kind'), coreVersion: flags.get('core-version') });
    } else if (command === 'test') {
      assertAllowedFlags(flags, ['kind']);
      if (positional.length > 1) throw usageError('test accepts at most one package directory');
      const root = positional[0] ?? '.';
      assertOutputOutsideRoot(root, flags.get('output'));
      report = testPackage(root, { kind: flags.get('kind') });
    } else if (command === 'compile') {
      assertAllowedFlags(flags, ['fqbn', 'example', 'arduino-cli', 'config', 'jobs', 'kind']);
      let root = '.';
      let profile = null;
      if (positional.length > 2) throw usageError('compile accepts [package-dir] [profile]');
      if (positional.length >= 1 && existsSync(resolve(positional[0])) && statSync(resolve(positional[0])).isDirectory()) {
        root = positional[0];
        profile = positional[1] ?? null;
      } else if (positional.length === 1) profile = positional[0];
      else if (positional.length === 2) throw usageError(`package directory does not exist: ${positional[0]}`);
      assertOutputOutsideRoot(root, flags.get('output'));
      report = compilePackage(root, {
        profile,
        fqbn: flags.get('fqbn'),
        example: flags.get('example'),
        arduinoCli: flags.get('arduino-cli'),
        config: flags.get('config'),
        jobs: flags.get('jobs'),
        kind: flags.get('kind'),
        reportOutput: flags.get('output'),
      });
    } else if (command === 'pack') {
      assertAllowedFlags(flags, ['out', 'force', 'kind']);
      if (positional.length > 1) throw usageError('pack accepts at most one package directory');
      report = packPackage(positional[0] ?? '.', {
        output: flags.get('out'),
        reportOutput: flags.get('output'),
        force: flags.get('force'),
        kind: flags.get('kind'),
      });
    } else throw usageError(`unknown command: ${command}`);
    assertOutputOutsidePackage(report, flags.get('output'));
    const exitCode = report.status === 'failed' ? EXIT.CHECK_FAILED : EXIT.OK;
    report.exit_code = exitCode;
    emitReport(report, flags);
    return exitCode;
  } catch (error) {
    const exitCode = Number.isInteger(error.exitCode) ? error.exitCode : EXIT.IO;
    const report = { ...baseReport(activeCommand, 'failed'), errors: [error.message], exit_code: exitCode };
    try {
      if (parsed) {
        const errorFlags = new Map(parsed.flags);
        if (error.suppressOutput) errorFlags.delete('output');
        emitReport(report, errorFlags);
      }
      else console.error(`ckpkg: ${error.message}`);
    } catch (emitError) {
      console.error(`ckpkg: ${error.message}\nckpkg report error: ${emitError.message}`);
    }
    if (exitCode === EXIT.USAGE && !parsed?.flags?.get('json')) console.error('\nRun ckpkg --help for usage.');
    return exitCode;
  }
}

let invokedAsMain = false;
if (process.argv[1]) {
  try {
    invokedAsMain = realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    invokedAsMain = pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
  }
}
if (invokedAsMain) process.exitCode = run();
