#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');

const {
  NATIVE_RELINK_PROFILE,
  evaluate,
  validateCandidate,
  validateAndEvaluateNativeRelink,
} = require('./Evaluate-CKForgePerformanceGate.cjs');
const {
  canonicalCompleteFqbn,
  hostEnvironmentFingerprint,
  inspectCliAndCore,
} = require('./Run-CKForgeNativeAB.cjs');
const { TARGETS: REGRESSION_TARGETS } = require('./Run-CKForgeRegression.cjs');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_EXECUTABLE = path.join(ROOT, 'target', 'release', 'appsdesktop.exe');
const DEFAULT_QUALIFICATION_ROOT = path.join(ROOT, 'state', 'qualifications');
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_CERTIFICATE_FILE_BYTES = 4 * 1024 * 1024;

function usage() {
  return [
    'Usage:',
    '  node scripts/Report-CKForgeFastQualifications.cjs [options]',
    '',
    'Options:',
    '  --exe <path>                 Hash this production executable (default: target/release/appsdesktop.exe).',
    '  --exe-sha256 <sha256>        Query a preserved executable identity without reading an EXE.',
    '  --qualification-root <path>  Certificate root (default: state/qualifications).',
    '  --architecture <id>          Filter by the FQBN architecture field, for example esp32 or avr.',
    '  --format <json|text>         Output format (default: json).',
    '  --help                       Show this help.',
    '',
    'Recomputed, executable-bound NativeRelink v4 certificates are counted as target Fast.',
    'Portable performance v2 certificates are reported separately as source-bound sample qualifications;',
    'their benchmark sketch binding never grants board-wide Fast status.',
    'Candidate registries, compatibility results, Exact cache hits and historical certificates are not Fast qualifications.',
  ].join('\n');
}

function parseArgs(argv) {
  const options = {
    executablePath: DEFAULT_EXECUTABLE,
    executableSha256: null,
    qualificationRoot: DEFAULT_QUALIFICATION_ROOT,
    architecture: null,
    format: 'json',
    help: false,
  };
  let executablePathExplicit = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${argument} requires a value`);
    }
    if (argument === '--exe') {
      options.executablePath = path.resolve(value);
      executablePathExplicit = true;
    } else if (argument === '--exe-sha256') {
      options.executableSha256 = value.toLowerCase();
    } else if (argument === '--qualification-root') {
      options.qualificationRoot = path.resolve(value);
    } else if (argument === '--architecture') {
      options.architecture = value.trim().toLowerCase();
    } else if (argument === '--format') {
      options.format = value.trim().toLowerCase();
    } else {
      throw new Error(`unknown option: ${argument}`);
    }
    index += 1;
  }
  if (options.executableSha256 && executablePathExplicit) {
    throw new Error('--exe and --exe-sha256 are mutually exclusive');
  }
  if (options.executableSha256 && !SHA256_PATTERN.test(options.executableSha256)) {
    throw new Error('--exe-sha256 must be a lowercase or uppercase 64-character SHA-256');
  }
  if (options.architecture !== null && !/^[a-z0-9._-]+$/.test(options.architecture)) {
    throw new Error('--architecture contains unsupported characters');
  }
  if (!['json', 'text'].includes(options.format)) {
    throw new Error('--format must be json or text');
  }
  return options;
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function assertRealDirectory(directory, label) {
  const metadata = fs.lstatSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory: ${directory}`);
  }
}

function readJsonFile(filePath, label) {
  const metadata = fs.lstatSync(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a real file`);
  }
  if (metadata.size <= 0 || metadata.size > MAX_CERTIFICATE_FILE_BYTES) {
    throw new Error(`${label} has an invalid size`);
  }
  const bytes = fs.readFileSync(filePath);
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error(`${label} is not valid UTF-8 JSON: ${error.message}`);
  }
  return { bytes, value };
}

function fqbnArchitecture(fqbn) {
  const fields = String(fqbn || '').split(':');
  return fields.length >= 3 ? fields[1].toLowerCase() : 'unknown';
}

function qualificationWorklist(qualifiedTargets, architecture = null) {
  const uniqueTargets = new Map();
  for (const target of REGRESSION_TARGETS) {
    if (architecture && target.architecture !== architecture) continue;
    if (!uniqueTargets.has(target.fqbn)) {
      uniqueTargets.set(target.fqbn, {
        id: target.id,
        label: target.label,
        fqbn: target.fqbn,
        architecture: target.architecture,
      });
    }
  }

  return [...uniqueTargets.values()].map((target) => {
    const certificates = qualifiedTargets
      .filter((qualified) => qualified.fqbn === target.fqbn)
      .map((qualified) => ({
        coreVersion: qualified.coreVersion,
        candidateProfile: qualified.candidateProfile,
        operation: qualified.operation,
        qualificationKey: qualified.qualificationKey,
      }));
    const qualified = certificates.length > 0;
    return {
      ...target,
      qualificationState: qualified ? 'fast-qualified' : 'qualification-pending',
      displayStatus: qualified
        ? 'Fast 已认证（仅限列出的精确证书身份）'
        : 'Fast 待验证（不等于不兼容；真实构建继续使用原生 Arduino CLI）',
      nativeFallbackProfile: qualified ? null : 'release',
      certificates,
    };
  });
}

function certificateHasExactShape(certificate) {
  const expectedKeys = [
    'candidateProfile',
    'evidenceSha256',
    'reportSha256',
    'schemaId',
    'schemaVersion',
  ];
  return util.isDeepStrictEqual(Object.keys(certificate).sort(), expectedKeys)
    && certificate.schemaId === 'ck.forge.local-performance-certificate'
    && certificate.schemaVersion === 4
    && certificate.candidateProfile === NATIVE_RELINK_PROFILE
    && SHA256_PATTERN.test(certificate.evidenceSha256)
    && SHA256_PATTERN.test(certificate.reportSha256);
}

function performanceCertificateHasExactShape(certificate) {
  const expectedKeys = [
    'artifactManifestSha256', 'candidateSha256', 'reportSha256', 'schemaId', 'schemaVersion',
  ];
  return util.isDeepStrictEqual(Object.keys(certificate).sort(), expectedKeys)
    && certificate.schemaId === 'ck.forge.local-performance-certificate'
    && certificate.schemaVersion === 2
    && SHA256_PATTERN.test(certificate.candidateSha256)
    && SHA256_PATTERN.test(certificate.reportSha256)
    && SHA256_PATTERN.test(certificate.artifactManifestSha256);
}

function artifactContentMultiset(artifacts, sizeField) {
  if (!Array.isArray(artifacts) || artifacts.length === 0 || artifacts.length > 64) return null;
  const values = new Map();
  for (const artifact of artifacts) {
    const size = artifact?.[sizeField];
    const digest = artifact?.sha256;
    if (!Number.isSafeInteger(size) || size <= 0 || !SHA256_PATTERN.test(String(digest || ''))) {
      return null;
    }
    const identity = `${size}:${digest}`;
    values.set(identity, (values.get(identity) || 0) + 1);
  }
  return values;
}

function validateInstalledArtifactManifest(directory, manifestFile, expectedArtifacts) {
  const manifest = manifestFile.value;
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
      || !util.isDeepStrictEqual(Object.keys(manifest).sort(), ['artifacts', 'schemaId', 'schemaVersion'])
      || manifest.schemaId !== 'ck.forge.qualification-artifact-set'
      || manifest.schemaVersion !== 1
      || !Array.isArray(manifest.artifacts)
      || manifest.artifacts.length === 0 || manifest.artifacts.length > 64) {
    throw new Error('artifact-manifest.json has an unsupported shape');
  }
  const canonicalRoot = fs.realpathSync.native(directory);
  const seen = new Set();
  let totalBytes = 0;
  for (const [index, artifact] of manifest.artifacts.entries()) {
    if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)
        || !util.isDeepStrictEqual(Object.keys(artifact).sort(), ['path', 'sha256', 'size'])
        || typeof artifact.path !== 'string' || artifact.path.includes('\\')
        || !artifact.path.startsWith('artifacts/')
        || artifact.path.split('/').some((part) => !part || part === '.' || part === '..')
        || !Number.isSafeInteger(artifact.size) || artifact.size <= 0
        || artifact.size > 128 * 1024 * 1024
        || !SHA256_PATTERN.test(String(artifact.sha256 || ''))
        || seen.has(artifact.path)) {
      throw new Error(`artifact-manifest.json artifacts[${index}] is invalid`);
    }
    seen.add(artifact.path);
    const file = path.join(directory, ...artifact.path.split('/'));
    const metadata = fs.lstatSync(file);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== artifact.size) {
      throw new Error(`installed artifact '${artifact.path}' is missing or has the wrong size`);
    }
    const canonical = fs.realpathSync.native(file);
    const relative = path.relative(canonicalRoot, canonical);
    if (relative.startsWith('..') || path.isAbsolute(relative)
        || sha256(fs.readFileSync(canonical)) !== artifact.sha256) {
      throw new Error(`installed artifact '${artifact.path}' escaped or failed SHA-256 validation`);
    }
    totalBytes += artifact.size;
    if (totalBytes > 512 * 1024 * 1024) throw new Error('installed artifact set exceeds 512 MiB');
  }
  const installed = artifactContentMultiset(manifest.artifacts, 'size');
  const expected = artifactContentMultiset(expectedArtifacts, 'bytes');
  if (!installed || !expected || installed.size !== expected.size
      || ![...installed].every(([identity, count]) => expected.get(identity) === count)) {
    throw new Error('installed artifact set does not match the candidate representative artifact set');
  }
}

function defaultCurrentIdentityResolver(target) {
  const current = inspectCliAndCore(target.fqbn, path.join(ROOT, 'arduino-cli-fast.yaml'));
  return { ...current, hostIdentitySha256: hostEnvironmentFingerprint(ROOT) };
}

function validatePerformanceCertificateDirectory(
  directory,
  expectedExecutableSha256,
  currentIdentityResolver = defaultCurrentIdentityResolver,
) {
  const key = path.basename(directory);
  if (!SHA256_PATTERN.test(key)) throw new Error('qualification directory name is not a SHA-256 key');
  assertRealDirectory(directory, 'qualification directory');
  const candidateFile = readJsonFile(path.join(directory, 'candidate.json'), 'candidate.json');
  const reportFile = readJsonFile(path.join(directory, 'report.json'), 'report.json');
  const certificateFile = readJsonFile(path.join(directory, 'certificate.json'), 'certificate.json');
  const manifestFile = readJsonFile(
    path.join(directory, 'artifact-manifest.json'), 'artifact-manifest.json',
  );
  const certificate = certificateFile.value;
  if (!performanceCertificateHasExactShape(certificate)) {
    throw new Error('certificate.json is not a closed performance v2 envelope');
  }
  const candidateSha256 = sha256(candidateFile.bytes);
  const reportSha256 = sha256(reportFile.bytes);
  const artifactManifestSha256 = sha256(manifestFile.bytes);
  if (certificate.candidateSha256 !== candidateSha256
      || certificate.reportSha256 !== reportSha256
      || certificate.artifactManifestSha256 !== artifactManifestSha256) {
    throw new Error('performance certificate content SHA-256 binding failed');
  }
  validateCandidate(candidateFile.value);
  const report = reportFile.value;
  const recomputed = evaluate(candidateFile.value, candidateSha256, report.evaluatedAt);
  if (!util.isDeepStrictEqual(recomputed, report)) {
    throw new Error('stored performance report differs from a fresh evaluation');
  }
  if (report.qualificationKey !== key
      || report.qualifiedFast !== true
      || report.status !== 'qualified-fast'
      || report.recommendedRoute !== 'ck-fast'
      || report.target?.productionExecutableSha256 !== expectedExecutableSha256) {
    throw new Error('performance certificate is not qualified for this production executable');
  }
  validateInstalledArtifactManifest(
    directory,
    manifestFile,
    candidateFile.value?.lanes?.native?.trials?.[0]?.['simple-return']?.artifacts,
  );
  const current = currentIdentityResolver(report.target, report);
  const normalizedCliVersion = (value) => String(value || '').replace(/\s+/gu, ' ').trim();
  if (!current
      || canonicalCompleteFqbn(current.fqbn) !== canonicalCompleteFqbn(report.target.fqbn)
      || current.coreVersion !== report.target.coreVersion
      || current.coreArchitecture !== report.target.coreArchitecture
      || current.cliExecutableSha256 !== report.target.cliExecutableSha256
      || current.cliConfigSha256 !== report.target.cliConfigSha256
      || normalizedCliVersion(current.cliVersion) !== normalizedCliVersion(report.target.cliVersion)
      || current.hostIdentitySha256 !== report.target.hostIdentitySha256) {
    throw new Error('current host, CLI, Core or complete FQBN identity differs from the certificate');
  }
  return {
    fqbn: report.target.fqbn,
    architecture: fqbnArchitecture(report.target.fqbn),
    coreVersion: report.target.coreVersion,
    toolchainKey: report.target.toolchainKey,
    candidateProfile: report.candidateProfile,
    operation: report.operation,
    qualificationKey: key,
    candidateSha256,
    reportSha256,
    evaluatedAt: report.evaluatedAt,
    qualificationKind: 'source-bound-sample-qualification',
    displayStatus: 'Source-bound sample qualification',
    qualificationScope: 'exact-portable-simple-source',
    sourceSha256: report.target.sketchSha256,
    targetWideFastGranted: false,
    runtimeStillRequiresExactToolchainKey: true,
  };
}

function validateCertificateDirectory(directory, expectedExecutableSha256) {
  const key = path.basename(directory);
  if (!SHA256_PATTERN.test(key)) throw new Error('qualification directory name is not a SHA-256 key');
  assertRealDirectory(directory, 'qualification directory');

  const evidenceFile = readJsonFile(path.join(directory, 'evidence.json'), 'evidence.json');
  const reportFile = readJsonFile(path.join(directory, 'report.json'), 'report.json');
  const certificateFile = readJsonFile(path.join(directory, 'certificate.json'), 'certificate.json');
  const evidenceSha256 = sha256(evidenceFile.bytes);
  const reportSha256 = sha256(reportFile.bytes);
  const { value: report } = reportFile;
  const { value: certificate } = certificateFile;

  if (!certificateHasExactShape(certificate)) throw new Error('certificate.json is not a closed NativeRelink v4 envelope');
  if (certificate.evidenceSha256 !== evidenceSha256) throw new Error('evidence SHA-256 does not match certificate');
  if (certificate.reportSha256 !== reportSha256) throw new Error('report SHA-256 does not match certificate');
  if (report.target?.productionExecutableSha256 !== expectedExecutableSha256) {
    throw new Error('report production executable identity changed during validation');
  }

  const recomputed = validateAndEvaluateNativeRelink(
    evidenceFile.value,
    evidenceSha256,
    report.evaluatedAt,
  );
  if (!util.isDeepStrictEqual(recomputed, report)) throw new Error('stored report differs from recomputed qualification report');
  if (report.qualificationKey !== key) throw new Error('qualification key does not match directory name');
  if (report.qualified !== true || report.status !== 'qualified-native-relink') {
    throw new Error('report is not a qualified NativeRelink result');
  }
  if (report.candidateProfile !== NATIVE_RELINK_PROFILE
      || report.recommendedRoute !== NATIVE_RELINK_PROFILE) {
    throw new Error('report does not authorize the NativeRelink compile-only route');
  }

  return {
    fqbn: report.target.fqbn,
    architecture: fqbnArchitecture(report.target.fqbn),
    coreVersion: report.target.coreVersion,
    toolchainKey: report.target.toolchainKey,
    candidateProfile: report.candidateProfile,
    operation: report.operation,
    nativeRelinkAdapterId: report.nativeRelinkAdapterId,
    nativeRelinkContractId: report.nativeRelinkContractId,
    artifactEquivalencePolicyId: report.artifactEquivalencePolicyId,
    qualificationKey: key,
    evidenceSha256,
    reportSha256,
    evaluatedAt: report.evaluatedAt,
  };
}

function resolveExecutableSha256(options) {
  if (options.executableSha256) return { sha256: options.executableSha256, executablePath: null };
  const metadata = fs.lstatSync(options.executablePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`production executable must be a real file: ${options.executablePath}`);
  }
  return {
    sha256: sha256(fs.readFileSync(options.executablePath)),
    executablePath: options.executablePath,
  };
}

function collectQualifications(options) {
  const executable = resolveExecutableSha256(options);
  assertRealDirectory(options.qualificationRoot, 'qualification root');
  const targets = [];
  const sourceBoundQualifications = [];
  const invalid = [];
  let inspectedNativeRelinkDirectories = 0;
  let inspectedPortablePerformanceDirectories = 0;
  const currentIdentityCache = new Map();
  const identityResolver = options.currentIdentityResolver || ((target) => {
    const key = canonicalCompleteFqbn(target.fqbn);
    if (!currentIdentityCache.has(key)) {
      currentIdentityCache.set(key, defaultCurrentIdentityResolver(target));
    }
    return currentIdentityCache.get(key);
  });

  for (const entry of fs.readdirSync(options.qualificationRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const directory = path.join(options.qualificationRoot, entry.name);
    const reportPath = path.join(directory, 'report.json');
    const certificatePath = path.join(directory, 'certificate.json');
    if (!fs.existsSync(reportPath) || !fs.existsSync(certificatePath)) continue;

    let report;
    let certificate;
    try {
      report = readJsonFile(reportPath, 'report.json').value;
      certificate = readJsonFile(certificatePath, 'certificate.json').value;
    } catch {
      continue;
    }
    if (certificate.schemaVersion === 4
        && report.schemaId === 'ck.forge.native-relink-local-qualification-report') {
      inspectedNativeRelinkDirectories += 1;
      if (report.target?.productionExecutableSha256 !== executable.sha256) continue;
      try {
        targets.push(validateCertificateDirectory(directory, executable.sha256));
      } catch (error) {
        invalid.push({ qualificationKey: entry.name, certificateKind: 'native-relink-v4', error: error.message });
      }
      continue;
    }
    if (certificate.schemaVersion === 2
        && report.schemaId === 'ck.forge.performance-qualification-report') {
      inspectedPortablePerformanceDirectories += 1;
      if (report.target?.productionExecutableSha256 !== executable.sha256) continue;
      try {
        sourceBoundQualifications.push(validatePerformanceCertificateDirectory(
          directory, executable.sha256, identityResolver,
        ));
      } catch (error) {
        invalid.push({ qualificationKey: entry.name, certificateKind: 'portable-performance-v2', error: error.message });
      }
    }
  }

  targets.sort((left, right) => left.fqbn.localeCompare(right.fqbn)
    || left.coreVersion.localeCompare(right.coreVersion)
    || left.qualificationKey.localeCompare(right.qualificationKey));
  const filteredTargets = options.architecture
    ? targets.filter((target) => target.architecture === options.architecture)
    : targets;
  sourceBoundQualifications.sort((left, right) => left.fqbn.localeCompare(right.fqbn)
    || left.coreVersion.localeCompare(right.coreVersion)
    || left.qualificationKey.localeCompare(right.qualificationKey));
  const filteredSourceBoundQualifications = options.architecture
    ? sourceBoundQualifications.filter((target) => target.architecture === options.architecture)
    : sourceBoundQualifications;
  const worklist = qualificationWorklist(targets, options.architecture);
  const pendingWorklist = worklist.filter(
    (target) => target.qualificationState === 'qualification-pending',
  );

  return {
    schemaId: 'ck.forge.current-fast-qualification-status',
    schemaVersion: 1,
    productionExecutableSha256: executable.sha256,
    productionExecutablePath: executable.executablePath
      ? path.relative(ROOT, executable.executablePath).replaceAll(path.sep, '/')
      : null,
    qualificationRoot: path.relative(ROOT, options.qualificationRoot).replaceAll(path.sep, '/'),
    architectureFilter: options.architecture,
    qualifiedTargetCount: filteredTargets.length,
    allArchitectureQualifiedTargetCount: targets.length,
    qualificationWorklistTargetCount: worklist.length,
    pendingQualificationTargetCount: pendingWorklist.length,
    invalidCurrentCertificateCount: invalid.length,
    inspectedNativeRelinkDirectoryCount: inspectedNativeRelinkDirectories,
    inspectedPortablePerformanceDirectoryCount: inspectedPortablePerformanceDirectories,
    sourceBoundQualifiedCapabilityCount: filteredSourceBoundQualifications.length,
    sourceBoundSampleQualificationCount: filteredSourceBoundQualifications.length,
    allArchitectureSourceBoundQualifiedCapabilityCount: sourceBoundQualifications.length,
    targets: filteredTargets,
    sourceBoundQualifications: filteredSourceBoundQualifications,
    qualificationWorklist: worklist,
    invalidCurrentCertificates: invalid,
    countingRules: {
      candidateRegistryGrantsFast: false,
      exactMatchGrantsFast: false,
      historicalExecutableCertificateGrantsFast: false,
      pendingQualificationMeansIncompatible: false,
      pendingQualificationUsesNativeArduinoCli: true,
      requiredSequence: ['simple', 'complex', 'medium', 'simple-return'],
      targetWideRequiredCertificateSchemaVersion: 4,
      targetWideRequiredProfile: NATIVE_RELINK_PROFILE,
      portablePerformanceCertificateSchemaVersion: 2,
      portablePerformanceQualificationScope: 'exact-portable-simple-source',
      portablePerformanceGrantsTargetWideFast: false,
      portablePerformanceRequiresRuntimeToolchainRecheck: true,
    },
  };
}

function renderText(report) {
  const lines = [
    `Production EXE SHA-256: ${report.productionExecutableSha256}`,
    `Architecture filter: ${report.architectureFilter || '(all)'}`,
    `Fast-qualified targets: ${report.qualifiedTargetCount}`,
    `Source-bound sample qualifications: ${report.sourceBoundSampleQualificationCount}`,
    `Qualification pending (not incompatible): ${report.pendingQualificationTargetCount}`,
  ];
  for (const target of report.targets) {
    lines.push(`- ${target.fqbn} | Core ${target.coreVersion} | ${target.candidateProfile} | ${target.qualificationKey}`);
  }
  for (const capability of report.sourceBoundQualifications) {
    lines.push(`- SOURCE-BOUND SAMPLE ${capability.fqbn} | ${capability.candidateProfile} | source ${capability.sourceSha256} | ${capability.qualificationKey}`);
  }
  for (const target of report.qualificationWorklist) {
    if (target.qualificationState !== 'qualification-pending') continue;
    lines.push(`- PENDING ${target.label} | ${target.fqbn} | native Arduino CLI Release remains available`);
  }
  if (report.invalidCurrentCertificateCount > 0) {
    lines.push(`INVALID CURRENT CERTIFICATES: ${report.invalidCurrentCertificateCount}`);
    for (const invalid of report.invalidCurrentCertificates) {
      lines.push(`- ${invalid.qualificationKey}: ${invalid.error}`);
    }
  }
  lines.push('Candidate registries, Exact matches and certificates for other EXE hashes are not counted.');
  lines.push('Source-bound sample qualifications authorize only their exact benchmark source and do not make a board target Fast-qualified.');
  lines.push('Pending means the exact target has not yet passed simple -> complex -> medium -> simple-return A/B for this EXE; it does not mean incompatible.');
  return `${lines.join('\n')}\n`;
}

function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv);
    if (options.help) {
      process.stdout.write(`${usage()}\n`);
      return 0;
    }
    const report = collectQualifications(options);
    process.stdout.write(options.format === 'text'
      ? renderText(report)
      : `${JSON.stringify(report, null, 2)}\n`);
    return report.invalidCurrentCertificateCount === 0 ? 0 : 1;
  } catch (error) {
    process.stderr.write(`CK Forge Fast qualification report: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = {
  collectQualifications,
  fqbnArchitecture,
  qualificationWorklist,
  main,
  parseArgs,
  renderText,
  validateCertificateDirectory,
  validatePerformanceCertificateDirectory,
};
