#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');

const gate = require('./Evaluate-CKForgePerformanceGate.cjs');
const runner = require('./Run-CKForgeNativeAB.cjs');

const CERTIFICATE_SCHEMA_ID = 'ck.forge.local-performance-certificate';
const ARTIFACT_MANIFEST_SCHEMA_ID = 'ck.forge.qualification-artifact-set';
const BUNDLE_SCHEMA_ID = 'ck.forge.performance-artifact-bundle';
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_CERTIFICATE_BYTES = 16 * 1024;
const MAX_ARTIFACTS = 64;
const MAX_ARTIFACT_BYTES = 128 * 1024 * 1024;
const MAX_ARTIFACT_SET_BYTES = 512 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/u;

function usage() {
  return `Install one qualified CK Forge portable Fast certificate

Usage:
  node scripts/Install-CKForgePerformanceQualification.cjs --plan \\
    --capture-report <native-ab.json> --candidate <candidate.json> \\
    --report <qualification-report.json> --artifact-bundle <directory> \\
    --qualification-root <state/qualifications>

  node scripts/Install-CKForgePerformanceQualification.cjs --install \\
    --capture-report <native-ab.json> --candidate <candidate.json> \\
    --report <qualification-report.json> --artifact-bundle <directory> \\
    --qualification-root <state/qualifications>

--plan performs every read-only validation and writes nothing. --install uses
the same validation, then atomically creates exactly one qualification-key
directory. Existing certificates are never overwritten. This command never
edits CK routing data or creates an allow-fast assertion.
`;
}

function normalizedPath(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function jsonPayload(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function parseArgs(argv) {
  const options = {
    action: null,
    captureReportPath: null,
    candidatePath: null,
    reportPath: null,
    artifactBundlePath: null,
    qualificationRoot: null,
    help: false,
  };
  const setAction = (action) => {
    if (options.action && options.action !== action) {
      throw new Error('choose exactly one of --plan or --install');
    }
    options.action = action;
  };
  const takePath = (index, label) => {
    const value = argv[index];
    if (!value) throw new Error(`${label} requires a path`);
    return path.resolve(process.cwd(), value);
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--plan') setAction('plan');
    else if (argument === '--install') setAction('install');
    else if (argument === '--capture-report') {
      options.captureReportPath = takePath(++index, argument);
    } else if (argument === '--candidate') {
      options.candidatePath = takePath(++index, argument);
    } else if (argument === '--report') {
      options.reportPath = takePath(++index, argument);
    } else if (argument === '--artifact-bundle') {
      options.artifactBundlePath = takePath(++index, argument);
    } else if (argument === '--qualification-root') {
      options.qualificationRoot = takePath(++index, argument);
    } else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`unknown argument '${argument}'`);
  }
  if (options.help || argv.length === 0) return { ...options, help: true };
  if (!options.action) throw new Error('choose --plan or --install');
  for (const [field, label] of [
    ['captureReportPath', '--capture-report'],
    ['candidatePath', '--candidate'],
    ['reportPath', '--report'],
    ['artifactBundlePath', '--artifact-bundle'],
    ['qualificationRoot', '--qualification-root'],
  ]) {
    if (!options[field]) throw new Error(`${label} is required`);
  }
  for (const file of [options.captureReportPath, options.candidatePath, options.reportPath]) {
    if (path.extname(file).toLowerCase() !== '.json') {
      throw new Error('capture, candidate and qualification report inputs must use .json');
    }
  }
  const uniqueFiles = new Set([
    options.captureReportPath, options.candidatePath, options.reportPath,
  ].map(normalizedPath));
  if (uniqueFiles.size !== 3) throw new Error('capture, candidate and report must be different files');
  return options;
}

function readRealFile(filePath, label, maximumBytes = MAX_JSON_BYTES) {
  const metadata = fs.lstatSync(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()
      || metadata.size <= 0 || metadata.size > maximumBytes) {
    throw new Error(`${label} must be a non-empty real file no larger than ${maximumBytes} bytes`);
  }
  const bytes = fs.readFileSync(filePath);
  return { bytes, value: JSON.parse(bytes.toString('utf8')) };
}

function assertRealDirectory(directory, label) {
  const metadata = fs.lstatSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory`);
  }
  return fs.realpathSync.native(directory);
}

function relativeArtifactPath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\')) return null;
  const components = value.split('/');
  if (components[0] !== 'artifacts'
      || components.length < 2
      || components.some((part) => part === '' || part === '.' || part === '..')) return null;
  if (path.isAbsolute(value) || /^[A-Za-z]:/u.test(value)) return null;
  return components.join(path.sep);
}

function artifactIdentity(artifact) {
  return `${artifact.size ?? artifact.bytes}:${artifact.sha256}`;
}

function multiset(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  return counts;
}

function equalMultiset(left, right) {
  if (left.size !== right.size) return false;
  return [...left].every(([key, count]) => right.get(key) === count);
}

function validateArtifactBundle(bundlePath, candidate, candidateSha256, captureReportSha256) {
  const canonicalRoot = assertRealDirectory(bundlePath, 'artifact bundle');
  const bundle = readRealFile(path.join(canonicalRoot, 'bundle.json'), 'bundle.json').value;
  const expectedBundleKeys = [
    'artifactManifestSha256', 'candidateSha256', 'captureReportSha256',
    'representativeLane', 'representativeStage', 'representativeTrialId',
    'schemaId', 'schemaVersion',
  ];
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)
      || !util.isDeepStrictEqual(Object.keys(bundle).sort(), expectedBundleKeys.sort())
      || bundle.schemaId !== BUNDLE_SCHEMA_ID
      || bundle.schemaVersion !== 1
      || bundle.candidateSha256 !== candidateSha256
      || bundle.captureReportSha256 !== captureReportSha256
      || bundle.representativeLane !== 'native'
      || bundle.representativeStage !== 'simple-return'
      || typeof bundle.representativeTrialId !== 'string'
      || !SHA256.test(String(bundle.artifactManifestSha256 || ''))) {
    throw new Error('artifact bundle metadata is malformed or not bound to these evidence files');
  }

  const manifestFile = readRealFile(
    path.join(canonicalRoot, 'artifact-manifest.json'), 'artifact-manifest.json',
  );
  if (sha256(manifestFile.bytes) !== bundle.artifactManifestSha256) {
    throw new Error('artifact bundle manifest SHA-256 does not match bundle.json');
  }
  const manifest = manifestFile.value;
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
      || !util.isDeepStrictEqual(Object.keys(manifest).sort(), ['artifacts', 'schemaId', 'schemaVersion'])
      || manifest.schemaId !== ARTIFACT_MANIFEST_SCHEMA_ID
      || manifest.schemaVersion !== 1
      || !Array.isArray(manifest.artifacts)
      || manifest.artifacts.length === 0
      || manifest.artifacts.length > MAX_ARTIFACTS) {
    throw new Error('artifact bundle manifest has an unsupported shape');
  }

  const representativeTrial = candidate?.lanes?.native?.trials?.[0];
  if (representativeTrial?.id !== bundle.representativeTrialId) {
    throw new Error('artifact bundle must preserve the first native trial as its fixed representative');
  }
  const expectedArtifacts = representativeTrial?.['simple-return']?.artifacts;
  if (!Array.isArray(expectedArtifacts) || expectedArtifacts.length === 0) {
    throw new Error('artifact bundle representative does not exist in the candidate');
  }

  const seen = new Set();
  const files = [];
  let totalBytes = 0;
  for (const [index, artifact] of manifest.artifacts.entries()) {
    if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)
        || !util.isDeepStrictEqual(Object.keys(artifact).sort(), ['path', 'sha256', 'size'])
        || !Number.isSafeInteger(artifact.size) || artifact.size <= 0
        || artifact.size > MAX_ARTIFACT_BYTES
        || !SHA256.test(String(artifact.sha256 || ''))) {
      throw new Error(`artifact-manifest.json artifacts[${index}] is invalid`);
    }
    const relative = relativeArtifactPath(artifact.path);
    if (!relative || seen.has(artifact.path)) {
      throw new Error(`artifact-manifest.json artifacts[${index}].path is unsafe or duplicated`);
    }
    seen.add(artifact.path);
    const sourcePath = path.join(canonicalRoot, relative);
    const metadata = fs.lstatSync(sourcePath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== artifact.size) {
      throw new Error(`artifact bundle file '${artifact.path}' is missing or has the wrong size`);
    }
    const canonical = fs.realpathSync.native(sourcePath);
    const rootPrefix = `${canonicalRoot}${path.sep}`;
    const comparableCanonical = normalizedPath(canonical);
    const comparableRootPrefix = normalizedPath(rootPrefix);
    if (!comparableCanonical.startsWith(comparableRootPrefix)) {
      throw new Error(`artifact bundle file '${artifact.path}' escapes its root`);
    }
    const bytes = fs.readFileSync(canonical);
    if (sha256(bytes) !== artifact.sha256) {
      throw new Error(`artifact bundle file '${artifact.path}' SHA-256 mismatch`);
    }
    totalBytes += artifact.size;
    if (totalBytes > MAX_ARTIFACT_SET_BYTES) throw new Error('artifact bundle exceeds 512 MiB');
    files.push({ relative: artifact.path, sourcePath: canonical, size: artifact.size, sha256: artifact.sha256 });
  }
  const actualSet = multiset(manifest.artifacts.map(artifactIdentity));
  const expectedSet = multiset(expectedArtifacts.map(artifactIdentity));
  if (!equalMultiset(actualSet, expectedSet)) {
    throw new Error('artifact bundle does not exactly match the candidate representative artifact set');
  }
  return { bundle, manifestBytes: manifestFile.bytes, files };
}

function validateInputs(options) {
  const captureFile = readRealFile(options.captureReportPath, 'raw A/B capture report');
  const candidateFile = readRealFile(options.candidatePath, 'performance candidate');
  const reportFile = readRealFile(options.reportPath, 'qualification report');
  const candidateSha256 = sha256(candidateFile.bytes);
  const captureReportSha256 = sha256(captureFile.bytes);
  const candidate = candidateFile.value;
  const report = reportFile.value;

  gate.validateCandidate(candidate);
  const projected = runner.performanceCandidateFromReport(captureFile.value, {
    qualificationOperation: candidate.operation,
    qualificationProfile: candidate.candidateProfile,
  });
  if (!util.isDeepStrictEqual(projected, candidate)) {
    throw new Error('candidate does not reproduce from the immutable raw A/B capture report');
  }
  if (typeof report?.evaluatedAt !== 'string' || !Number.isFinite(Date.parse(report.evaluatedAt))) {
    throw new Error('qualification report evaluatedAt is invalid');
  }
  const recomputed = gate.evaluate(candidate, candidateSha256, report.evaluatedAt);
  if (!util.isDeepStrictEqual(recomputed, report)) {
    throw new Error('qualification report differs from a fresh evaluation of the candidate');
  }
  if (report.qualifiedFast !== true
      || report.status !== 'qualified-fast'
      || report.recommendedRoute !== 'ck-fast'
      || !SHA256.test(String(report.qualificationKey || ''))) {
    throw new Error('performance evidence did not qualify; no certificate may be installed');
  }
  const artifactBundle = validateArtifactBundle(
    options.artifactBundlePath, candidate, candidateSha256, captureReportSha256,
  );
  return {
    qualificationKey: report.qualificationKey,
    candidateBytes: candidateFile.bytes,
    candidateSha256,
    reportBytes: reportFile.bytes,
    reportSha256: sha256(reportFile.bytes),
    captureReportSha256,
    artifactManifestBytes: artifactBundle.manifestBytes,
    artifactManifestSha256: sha256(artifactBundle.manifestBytes),
    artifactFiles: artifactBundle.files,
    target: report.target,
    operation: report.operation,
    candidateProfile: report.candidateProfile,
  };
}

function assertNoSymlinkAncestors(target) {
  let cursor = path.resolve(target);
  const pending = [];
  while (!fs.existsSync(cursor)) {
    pending.push(cursor);
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  if (!fs.existsSync(cursor)) throw new Error('qualification root has no existing ancestor');
  const metadata = fs.lstatSync(cursor);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('qualification root ancestor must be a real directory');
  }
  for (const item of pending.reverse()) {
    if (fs.existsSync(item) && fs.lstatSync(item).isSymbolicLink()) {
      throw new Error('qualification root path must not traverse symbolic links');
    }
  }
}

function destinationFor(options, qualificationKey) {
  return path.join(options.qualificationRoot, qualificationKey);
}

function installValidated(options, validated) {
  assertNoSymlinkAncestors(options.qualificationRoot);
  fs.mkdirSync(options.qualificationRoot, { recursive: true });
  const canonicalRoot = assertRealDirectory(options.qualificationRoot, 'qualification root');
  const destination = path.join(canonicalRoot, validated.qualificationKey);
  if (fs.existsSync(destination)) {
    throw new Error('qualification certificate already exists; refusing to overwrite');
  }
  const temporary = path.join(
    canonicalRoot,
    `.performance-${process.pid}-${crypto.randomBytes(8).toString('hex')}.tmp`,
  );
  const certificate = {
    schemaId: CERTIFICATE_SCHEMA_ID,
    schemaVersion: 2,
    candidateSha256: validated.candidateSha256,
    reportSha256: validated.reportSha256,
    artifactManifestSha256: validated.artifactManifestSha256,
  };
  const certificateBytes = jsonPayload(certificate);
  if (certificateBytes.length > MAX_CERTIFICATE_BYTES) throw new Error('certificate envelope is too large');
  try {
    fs.mkdirSync(temporary, { recursive: false });
    fs.writeFileSync(path.join(temporary, 'candidate.json'), validated.candidateBytes, { flag: 'wx' });
    fs.writeFileSync(path.join(temporary, 'report.json'), validated.reportBytes, { flag: 'wx' });
    fs.writeFileSync(
      path.join(temporary, 'artifact-manifest.json'), validated.artifactManifestBytes, { flag: 'wx' },
    );
    for (const artifact of validated.artifactFiles) {
      const output = path.join(temporary, ...artifact.relative.split('/'));
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.copyFileSync(artifact.sourcePath, output, fs.constants.COPYFILE_EXCL);
      const copied = fs.readFileSync(output);
      if (copied.length !== artifact.size || sha256(copied) !== artifact.sha256) {
        throw new Error(`copied artifact '${artifact.relative}' failed post-copy verification`);
      }
    }
    fs.writeFileSync(path.join(temporary, 'certificate.json'), certificateBytes, { flag: 'wx' });
    fs.renameSync(temporary, destination);
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
  return destination;
}

function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv);
    if (options.help) {
      process.stdout.write(usage());
      return 0;
    }
    const validated = validateInputs(options);
    const destination = destinationFor(options, validated.qualificationKey);
    if (options.action === 'plan') {
      process.stdout.write(`${JSON.stringify({
        action: 'install-qualified-performance-certificate',
        writesFiles: false,
        qualificationKey: validated.qualificationKey,
        destination,
        fqbn: validated.target.fqbn,
        operation: validated.operation,
        candidateProfile: validated.candidateProfile,
        candidateSha256: validated.candidateSha256,
        reportSha256: validated.reportSha256,
        artifactManifestSha256: validated.artifactManifestSha256,
        artifactCount: validated.artifactFiles.length,
      }, null, 2)}\nVALIDATED; no files were written.\n`);
      return 0;
    }
    const installed = installValidated(options, validated);
    process.stdout.write(`INSTALLED-QUALIFIED-PERFORMANCE ${installed}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`CK Forge qualification installer: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = {
  ARTIFACT_MANIFEST_SCHEMA_ID,
  BUNDLE_SCHEMA_ID,
  CERTIFICATE_SCHEMA_ID,
  destinationFor,
  equalMultiset,
  installValidated,
  jsonPayload,
  main,
  parseArgs,
  relativeArtifactPath,
  sha256,
  validateArtifactBundle,
  validateInputs,
};
