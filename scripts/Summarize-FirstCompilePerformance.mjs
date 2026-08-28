#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const SUMMARY_SCHEMA_ID = 'ck.first-compile-performance-summary';
export const SUMMARY_SCHEMA_VERSION = 1;
export const MINIMUM_SAMPLES_PER_MODE = 3;
export const TARGET_IMPROVEMENT_PERCENT = 30;
export const MAXIMUM_BATCH_SPAN_HOURS = 2;
export const MAXIMUM_EVIDENCE_AGE_HOURS = 72;
export const FUTURE_TIMESTAMP_TOLERANCE_MINUTES = 5;

const MAX_INPUT_BYTES = 16 * 1024 * 1024;
const MAX_REFERENCE_JSON_BYTES = 32 * 1024 * 1024;
const MODE_FIRST = 'firstProjectCold';
const MODE_READY = 'readyInstallCold';
const MODES = [MODE_FIRST, MODE_READY];
const REQUIRED_TEMPORAL_SEQUENCE = Object.freeze([
  MODE_FIRST,
  MODE_READY,
  MODE_FIRST,
  MODE_READY,
  MODE_FIRST,
  MODE_READY,
]);
const MODE_COMPILE_PROFILE_POLICY = Object.freeze({
  [MODE_FIRST]: Object.freeze({ cold: 'quick-fast', upload: 'quick-fast' }),
  [MODE_READY]: Object.freeze({ cold: 'quick-fast', upload: 'shared-fast' }),
});
const MODE_CACHE_CLEAR_POLICY = Object.freeze({
  [MODE_FIRST]: Object.freeze({
    reset_scope: 'first-project-full-fqbn',
    ccache_store_preserved: true,
    prebuilt_core_preserved: false,
    prebuilt_core_validated: false,
    force_rebuild_pending: false,
    force_ccache_recache: false,
  }),
  [MODE_READY]: Object.freeze({
    reset_scope: 'ready-install-project-full-fqbn',
    ccache_store_preserved: true,
    prebuilt_core_preserved: true,
    prebuilt_core_validated: true,
    force_rebuild_pending: false,
    force_ccache_recache: false,
  }),
});
const REQUIRED_BENCHMARK_CHECK_IDS = Object.freeze([
  'cold-stage-verified-or-explicitly-skipped',
  'exact-cache-hit-confirmed',
  'hot-edit-code-change-confirmed',
  'generated-source-restored',
  'upload-stage-verified-or-explicitly-skipped',
]);
const verifiedRecords = new WeakMap();
const verifiedBatches = new WeakMap();

class EvidenceError extends Error {
  constructor(id, message) {
    super(message);
    this.name = 'EvidenceError';
    this.id = id;
  }
}

function round(value, digits = 3) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isSha256(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
}

function isPositiveSafeInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function parseEvidenceTimestamp(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/i);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction = '', zone, sign, offsetHourText, offsetMinuteText] = match;
  const [year, month, day, hour, minute, second] = [
    yearText, monthText, dayText, hourText, minuteText, secondText,
  ].map(Number);
  const millisecond = Number(fraction.padEnd(3, '0').slice(0, 3));
  const wallClock = new Date(0);
  wallClock.setUTCFullYear(year, month - 1, day);
  wallClock.setUTCHours(hour, minute, second, millisecond);
  if (wallClock.getUTCFullYear() !== year
    || wallClock.getUTCMonth() !== month - 1
    || wallClock.getUTCDate() !== day
    || wallClock.getUTCHours() !== hour
    || wallClock.getUTCMinutes() !== minute
    || wallClock.getUTCSeconds() !== second) return null;
  let offsetMinutes = 0;
  if (zone.toUpperCase() !== 'Z') {
    const offsetHour = Number(offsetHourText);
    const offsetMinute = Number(offsetMinuteText);
    if (offsetHour > 23 || offsetMinute > 59) return null;
    offsetMinutes = (offsetHour * 60 + offsetMinute) * (sign === '+' ? 1 : -1);
  }
  const millis = wallClock.getTime() - offsetMinutes * 60_000;
  return Number.isFinite(millis) ? millis : null;
}

function own(value, key) {
  return value != null && Object.prototype.hasOwnProperty.call(value, key);
}

function pick(value, ...keys) {
  for (const key of keys) {
    if (own(value, key)) return value[key];
  }
  return undefined;
}

function sha256Text(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function documentFingerprint(document) {
  return sha256Text(JSON.stringify(document));
}

function normalizePathKey(value) {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function pathIsWithin(root, candidate, allowRoot = false) {
  const relative = path.relative(root, candidate);
  if (relative === '') return allowRoot;
  return relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function normalizeRecordedRelativePath(value, label) {
  if (!isNonEmptyString(value)) {
    throw new EvidenceError('invalid-reference-path', `${label} must be a non-empty relative path.`);
  }
  const text = value.trim();
  if (text.includes('\0')
    || path.isAbsolute(text)
    || /^[a-z]:[\\/]/i.test(text)
    || /^\\\\/.test(text)
    || /^<[^>]+>(?:[\\/]|$)/.test(text)) {
    throw new EvidenceError('reference-path-not-root-relative', `${label} must be relative to --root.`);
  }
  const segments = text.replaceAll('\\', '/').split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new EvidenceError('reference-path-escape', `${label} contains an unsafe path segment.`);
  }
  return segments.join('/');
}

async function resolveRootFile(rootReal, recordedPath, label) {
  const normalized = normalizeRecordedRelativePath(recordedPath, label);
  const candidate = path.resolve(rootReal, ...normalized.split('/'));
  if (!pathIsWithin(rootReal, candidate)) {
    throw new EvidenceError('reference-path-escape', `${label} escapes --root.`);
  }
  let candidateReal;
  try {
    candidateReal = await realpath(candidate);
  } catch {
    throw new EvidenceError('reference-file-missing', `${label} does not identify an existing file.`);
  }
  if (!pathIsWithin(rootReal, candidateReal)) {
    throw new EvidenceError('reference-realpath-escape', `${label} resolves outside --root.`);
  }
  const linkMetadata = await lstat(candidate);
  const metadata = await stat(candidateReal);
  if (linkMetadata.isSymbolicLink() || !metadata.isFile()) {
    throw new EvidenceError('reference-not-regular-file', `${label} must identify a regular file.`);
  }
  return { absolutePath: candidateReal, relativePath: normalized, metadata };
}

async function sha256File(absolutePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    let bytes = 0;
    const stream = createReadStream(absolutePath);
    stream.on('data', (chunk) => {
      bytes += chunk.length;
      hash.update(chunk);
    });
    stream.on('error', reject);
    stream.on('end', () => resolve({ sha256: hash.digest('hex'), bytes }));
  });
}

async function readJsonReference(reference, label) {
  if (reference.metadata.size <= 0 || reference.metadata.size > MAX_REFERENCE_JSON_BYTES) {
    throw new EvidenceError(
      'reference-json-size-invalid',
      `${label} must be between 1 and ${MAX_REFERENCE_JSON_BYTES} bytes.`,
    );
  }
  try {
    return JSON.parse(await readFile(reference.absolutePath, 'utf8'));
  } catch {
    throw new EvidenceError('reference-json-invalid', `${label} is not valid JSON.`);
  }
}

export function canonicalizeFqbn(value) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  const parts = text.split(':');
  if (parts.length !== 3 && parts.length !== 4) return '';
  const idPattern = /^[a-z0-9][a-z0-9_.-]*$/i;
  const base = parts.slice(0, 3).map((part) => part.trim());
  if (base.some((part) => !idPattern.test(part))) return '';
  const canonicalBase = base.map((part) => part.toLowerCase()).join(':');
  if (parts.length === 3) return canonicalBase;
  const optionText = parts[3].trim();
  if (!optionText) return '';
  const seenKeys = new Set();
  const options = [];
  for (const rawOption of optionText.split(',')) {
    const option = rawOption.trim();
    const equalsAt = option.indexOf('=');
    if (equalsAt <= 0 || equalsAt !== option.lastIndexOf('=')) return '';
    const key = option.slice(0, equalsAt).trim();
    const optionValue = option.slice(equalsAt + 1).trim();
    if (!idPattern.test(key)
      || !optionValue
      || /[\s,:=\u0000-\u001f\u007f]/.test(optionValue)) return '';
    const keyIdentity = key.toLowerCase();
    if (seenKeys.has(keyIdentity)) return '';
    seenKeys.add(keyIdentity);
    options.push({ key, optionValue });
  }
  options.sort((left, right) => {
    const keyOrder = left.key.toLowerCase().localeCompare(right.key.toLowerCase(), 'en');
    if (keyOrder !== 0) return keyOrder;
    return left.optionValue.localeCompare(right.optionValue, 'en');
  });
  return `${canonicalBase}:${options.map(({ key, optionValue }) => `${key}=${optionValue}`).join(',')}`;
}

export function calculateStatistics(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  if (values.some((value) => typeof value !== 'number' || !Number.isFinite(value) || value <= 0)) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
  // Nearest-rank percentile: P95 = x[ceil(0.95 * n)], with a one-based rank.
  const p95 = sorted[Math.max(0, Math.ceil(0.95 * sorted.length) - 1)];
  return {
    count: sorted.length,
    medianSeconds: round(median),
    maxSeconds: round(sorted.at(-1)),
    p95Seconds: round(p95),
  };
}

function normalizeHeaders(value) {
  if (!Array.isArray(value) || value.some((header) => typeof header !== 'string')) return null;
  return value
    .map((header) => header.trim().toLowerCase())
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right, 'en'));
}

function normalizeCompileProfile(value) {
  if (!isNonEmptyString(value)) return '';
  const match = value.trim().match(/^([a-z0-9][a-z0-9-]*)(?:\s+\([^\r\n]*\))?$/i);
  return match ? match[1].toLowerCase() : '';
}

function validateVerifiedBaseline(document, addFailure, evidencePath) {
  const baseline = document?.verified_baseline || document?.verifiedBaseline;
  if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline)) {
    addFailure(
      'missing-verified-upload-baseline',
      evidencePath,
      'A complete verified_baseline created by a successful upload is required.',
    );
    return null;
  }
  const environment = baseline.environment;
  const environmentFqbn = canonicalizeFqbn(environment?.fqbn);
  const topFqbn = canonicalizeFqbn(document?.fqbn);
  const stringFields = [
    'coreId',
    'coreVersion',
    'arduinoCliVersion',
    'toolchainKey',
    'buildSignature',
    'compileProfile',
    'optimization',
  ];
  const environmentValid = environment
    && typeof environment === 'object'
    && !Array.isArray(environment)
    && environmentFqbn
    && environmentFqbn === topFqbn
    && stringFields.every((field) => isNonEmptyString(environment[field]));

  const firmware = baseline.firmware;
  const artifacts = firmware?.artifacts;
  const artifactAddresses = new Set();
  const artifactsValid = Array.isArray(artifacts)
    && artifacts.length > 0
    && artifacts.every((artifact) => {
      const address = artifact?.flashAddress;
      const valid = isNonEmptyString(artifact?.role)
        && typeof address === 'string'
        && /^0x[0-9a-f]+$/i.test(address)
        && isPositiveSafeInteger(artifact?.size)
        && isSha256(artifact?.sha256)
        && !artifactAddresses.has(address.toLowerCase());
      if (valid) artifactAddresses.add(address.toLowerCase());
      return valid;
    });
  const firmwareValid = firmware
    && typeof firmware === 'object'
    && isSha256(firmware.manifestSha256)
    && isSha256(firmware.partitionSha256)
    && artifactsValid;

  const device = baseline.device;
  const deviceValid = device
    && typeof device === 'object'
    && isNonEmptyString(device.chip)
    && (device.revision == null || isNonEmptyString(device.revision))
    && isPositiveSafeInteger(device.flashBytes)
    && (device.psramBytes == null || isPositiveSafeInteger(device.psramBytes));

  const resources = baseline.resources;
  const resourceFields = ['flashUsedBytes', 'flashMaxBytes', 'ramUsedBytes', 'ramMaxBytes', 'warningCount'];
  const resourcesValid = resources
    && typeof resources === 'object'
    && resourceFields.every((field) => isNonNegativeSafeInteger(resources[field]))
    && resources.flashMaxBytes > 0
    && resources.ramMaxBytes > 0
    && resources.flashUsedBytes <= resources.flashMaxBytes
    && resources.ramUsedBytes <= resources.ramMaxBytes;
  const createdMillis = parseEvidenceTimestamp(baseline.createdAt);
  const verifiedMillis = parseEvidenceTimestamp(baseline.verifiedAt);
  const timestampsValid = createdMillis != null && verifiedMillis != null;
  if (!timestampsValid) {
    addFailure(
      'invalid-verified-baseline-timestamps',
      evidencePath,
      'verified_baseline createdAt and verifiedAt must be timezone-qualified timestamps.',
    );
  }
  if (!environmentValid || !firmwareValid || !deviceValid || !resourcesValid) {
    addFailure(
      'incomplete-verified-upload-baseline',
      evidencePath,
      'verified_baseline must contain valid environment, firmware, device, and resource evidence.',
    );
  }
  if (!environmentValid || !firmwareValid || !deviceValid || !resourcesValid || !timestampsValid) return null;
  return {
    environment: {
      fqbn: environmentFqbn,
      ...Object.fromEntries(stringFields.map((field) => [field, environment[field].trim()])),
    },
    device: {
      chip: device.chip.trim(),
      revision: device.revision == null ? null : device.revision.trim(),
      flashBytes: device.flashBytes,
      psramBytes: device.psramBytes ?? null,
    },
    temporal: { createdMillis, verifiedMillis },
  };
}

function bindingFromDocument(document, addFailure, evidencePath) {
  const project = isNonEmptyString(document?.project) ? document.project.trim() : '';
  const rawPort = isNonEmptyString(document?.port) ? document.port.trim() : '';
  const port = /^com[0-9]+$/i.test(rawPort) ? rawPort.toUpperCase() : rawPort;
  if (!project || !port) {
    addFailure(
      'missing-project-or-port-binding',
      evidencePath,
      'A non-empty project and serial port binding are required.',
    );
  }
  const fqbn = canonicalizeFqbn(document?.fqbn);
  if (!fqbn) {
    addFailure('missing-full-fqbn', evidencePath, 'The complete benchmark FQBN is missing or invalid.');
  }

  const initial = document?.sourceGate?.initial;
  const codeFingerprint = initial?.codeFingerprint;
  const includeSignature = initial?.includeSignature;
  const includeHeaders = normalizeHeaders(initial?.includeHeaders);
  if (!isNonEmptyString(codeFingerprint)) {
    addFailure(
      'missing-initial-source-fingerprint',
      evidencePath,
      'The initial generated-source fingerprint is missing.',
    );
  }
  if (typeof includeSignature !== 'string' || includeHeaders == null) {
    addFailure(
      'missing-initial-include-evidence',
      evidencePath,
      'The initial include signature or include list is missing.',
    );
  } else if (includeSignature.trim().toLowerCase() !== includeHeaders.join('|')) {
    addFailure(
      'inconsistent-initial-include-evidence',
      evidencePath,
      'The initial include signature does not match the normalized include list.',
    );
  }

  const sourceTree = document?.source_tree || document?.sourceTree;
  const treeSha256 = pick(sourceTree, 'tree_sha256', 'treeSha256');
  const sourceManifestSha256 = pick(sourceTree, 'manifest_sha256', 'manifestSha256');
  const freezeRecordSha256 = pick(sourceTree, 'freeze_record_sha256', 'freezeRecordSha256');
  if (!isSha256(treeSha256) || !isSha256(sourceManifestSha256) || !isSha256(freezeRecordSha256)) {
    addFailure(
      'invalid-source-tree-binding',
      evidencePath,
      'Source tree, manifest, and freeze-record SHA-256 bindings are required.',
    );
  }

  const gate = document?.gate_run || document?.gateRun;
  const gateRunId = pick(gate, 'run_id', 'runId');
  const gateReportSha256 = pick(gate, 'report_sha256', 'reportSha256');
  const gateFinishedAt = pick(gate, 'finished_at', 'finishedAt');
  const gateFinishedMillis = parseEvidenceTimestamp(gateFinishedAt);
  if (!isNonEmptyString(gateRunId) || !isSha256(gateReportSha256) || gate?.status !== 'passed') {
    addFailure(
      'invalid-gate-binding',
      evidencePath,
      'A passed release-gate run ID and report SHA-256 binding are required.',
    );
  }

  const executable = document?.executable;
  const executableSha256 = executable?.sha256;
  const executableBytes = executable?.bytes;
  const executableProcessId = pick(executable, 'process_id', 'processId');
  const executableStartedAt = pick(executable, 'process_started_at', 'processStartedAt');
  const executableStartedMillis = parseEvidenceTimestamp(executableStartedAt);
  if (!isSha256(executableSha256)
    || !isPositiveSafeInteger(executableBytes)
    || !isPositiveSafeInteger(executableProcessId)) {
    addFailure(
      'invalid-production-executable-binding',
      evidencePath,
      'A production executable SHA-256, positive byte size, and positive process ID are required.',
    );
  }
  const cdpBinding = document?.cdp_binding || document?.cdpBinding;
  const cdpExecutableSha = pick(cdpBinding, 'executable_sha256', 'executableSha256');
  const cdpProcessId = pick(cdpBinding, 'process_id', 'processId');
  if (cdpBinding?.bound !== true
    || !isSha256(cdpExecutableSha)
    || String(cdpExecutableSha).toLowerCase() !== String(executableSha256).toLowerCase()
    || !isPositiveSafeInteger(cdpProcessId)
    || cdpProcessId !== executableProcessId) {
    addFailure(
      'invalid-native-production-session-binding',
      evidencePath,
      'CDP must be bound to the same production executable hash and process ID.',
    );
  }
  const bindingVerification = document?.binding_verification || document?.bindingVerification;
  if (bindingVerification?.unchanged !== true) {
    addFailure(
      'native-binding-not-verified-unchanged',
      evidencePath,
      'The native source, gate, and executable binding was not verified unchanged after the run.',
    );
  }
  const verificationSchema = pick(bindingVerification, 'schema_version', 'schemaVersion');
  const verifiedBeforeAt = pick(bindingVerification, 'verified_before_at', 'verifiedBeforeAt');
  const verifiedAfterAt = pick(bindingVerification, 'verified_after_at', 'verifiedAfterAt');
  const verifiedBeforeMillis = parseEvidenceTimestamp(verifiedBeforeAt);
  const verifiedAfterMillis = parseEvidenceTimestamp(verifiedAfterAt);
  const capturedAt = document?.capturedAt;
  const capturedMillis = parseEvidenceTimestamp(capturedAt);
  const temporalEnvelopeValid = verificationSchema === 1
    && gateFinishedMillis != null
    && executableStartedMillis != null
    && verifiedBeforeMillis != null
    && capturedMillis != null
    && verifiedAfterMillis != null
    && gateFinishedMillis <= executableStartedMillis
    && executableStartedMillis <= verifiedBeforeMillis
    && verifiedBeforeMillis <= capturedMillis
    && capturedMillis <= verifiedAfterMillis;
  if (!temporalEnvelopeValid) {
    addFailure(
      'invalid-native-time-envelope',
      evidencePath,
      'Native evidence must prove gate finished <= executable started <= verified before <= capturedAt <= verified after.',
    );
  }

  const baseline = validateVerifiedBaseline(document, addFailure, evidencePath);
  if (baseline && (!temporalEnvelopeValid || !(verifiedBeforeMillis <= capturedMillis
    && capturedMillis <= baseline.temporal.createdMillis
    && baseline.temporal.createdMillis <= baseline.temporal.verifiedMillis
    && baseline.temporal.verifiedMillis <= verifiedAfterMillis))) {
    addFailure(
      'invalid-verified-baseline-time-envelope',
      evidencePath,
      'Verified upload timing must prove verified before <= capturedAt <= baseline createdAt <= baseline verifiedAt <= verified after.',
    );
  }
  return {
    project: project || null,
    port: port || null,
    fqbn,
    initialSource: {
      codeFingerprint: isNonEmptyString(codeFingerprint) ? codeFingerprint.trim() : null,
      includeSignature: typeof includeSignature === 'string'
        ? includeSignature.trim().toLowerCase()
        : null,
      includeHeaders,
    },
    sourceTree: {
      treeSha256: isSha256(treeSha256) ? treeSha256.toLowerCase() : null,
      manifestSha256: isSha256(sourceManifestSha256) ? sourceManifestSha256.toLowerCase() : null,
      freezeRecordSha256: isSha256(freezeRecordSha256)
        ? freezeRecordSha256.toLowerCase()
        : null,
    },
    gateRun: {
      runId: isNonEmptyString(gateRunId) ? gateRunId.trim() : null,
      reportSha256: isSha256(gateReportSha256) ? gateReportSha256.toLowerCase() : null,
      status: gate?.status === 'passed' ? 'passed' : null,
      finishedAt: gateFinishedMillis == null ? null : gateFinishedAt,
    },
    executable: {
      sha256: isSha256(executableSha256) ? executableSha256.toLowerCase() : null,
      bytes: isPositiveSafeInteger(executableBytes) ? executableBytes : null,
      processId: isPositiveSafeInteger(executableProcessId) ? executableProcessId : null,
      startedAt: executableStartedMillis == null ? null : executableStartedAt,
    },
    environment: baseline?.environment ?? null,
    device: baseline?.device ?? null,
    sampleTemporal: temporalEnvelopeValid ? {
      gateFinishedMillis,
      executableStartedMillis,
      verifiedBeforeMillis,
      capturedMillis,
      verifiedAfterMillis,
      baselineCreatedMillis: baseline?.temporal.createdMillis ?? null,
      baselineVerifiedMillis: baseline?.temporal.verifiedMillis ?? null,
    } : null,
  };
}

function stableBinding(binding) {
  if (!binding) return JSON.stringify(binding);
  const { sampleTemporal: _sampleTemporal, ...commonBinding } = binding;
  const { compileProfile: _modeScopedProfile, ...commonEnvironment } = binding.environment || {};
  return JSON.stringify({ ...commonBinding, environment: commonEnvironment });
}

function publicBinding(binding) {
  if (!binding) return null;
  return {
    fqbn: binding.fqbn,
    initialSource: {
      sourceFingerprintBindingSha256: binding.initialSource.codeFingerprint
        ? sha256Text(binding.initialSource.codeFingerprint)
        : null,
      includeSignature: binding.initialSource.includeSignature,
    },
    sourceTree: binding.sourceTree,
    gateRun: {
      reportSha256: binding.gateRun.reportSha256,
      status: binding.gateRun.status,
    },
    executable: {
      sha256: binding.executable.sha256,
      bytes: binding.executable.bytes,
      processId: binding.executable.processId,
    },
    environment: binding.environment,
    project: binding.project,
    port: binding.port,
    device: binding.device,
  };
}

function validateBenchmarkOutcomeEnvelope(document, addFailure, evidencePath) {
  const skippedStages = document?.skippedStages;
  const failures = document?.failures;
  const checks = document?.checks;
  const checkIds = new Set();
  const checksValid = Array.isArray(checks)
    && checks.length === REQUIRED_BENCHMARK_CHECK_IDS.length
    && checks.every((check) => {
      const id = isNonEmptyString(check?.id) ? check.id.trim() : '';
      if (!id || check?.passed !== true || checkIds.has(id)) return false;
      checkIds.add(id);
      return true;
    })
    && REQUIRED_BENCHMARK_CHECK_IDS.every((id) => checkIds.has(id));
  if (!Array.isArray(skippedStages)
    || skippedStages.length !== 0
    || !Array.isArray(failures)
    || failures.length !== 0
    || !checksValid) {
    addFailure(
      'invalid-benchmark-outcome-envelope',
      evidencePath,
      'Benchmark evidence must contain no skipped stages or failures and exactly the five passed outcome checks.',
    );
  }
}

function validateCacheClearIdentity(document, mode, addFailure, evidencePath) {
  const expected = MODE_CACHE_CLEAR_POLICY[mode];
  if (!expected) return;
  const cacheClear = document?.cacheClear;
  const targetFqbn = isNonEmptyString(document?.fqbn) ? document.fqbn.trim() : '';
  const cacheFqbn = isNonEmptyString(cacheClear?.fqbn) ? cacheClear.fqbn.trim() : '';
  const valid = cacheClear
    && typeof cacheClear === 'object'
    && !Array.isArray(cacheClear)
    && canonicalizeFqbn(targetFqbn)
    && cacheFqbn === targetFqbn
    && Object.entries(expected).every(([field, value]) => cacheClear[field] === value);
  if (!valid) {
    addFailure(
      'invalid-cache-clear-identity',
      evidencePath,
      `${mode} cacheClear must exactly identify the full FQBN reset scope and literal cache-preservation booleans.`,
    );
  }
}

function nativeCompileOperationValid(operation) {
  return operation?.schemaId === 'ck.native-compile-upload-operation'
    && operation?.schemaVersion === 1
    && operation?.kind === 'compile'
    && operation?.success === true
    && typeof operation?.wallSeconds === 'number'
    && Number.isFinite(operation.wallSeconds)
    && operation.wallSeconds > 0
    && normalizeCompileProfile(operation.profile) === 'quick-fast';
}

function validateSupportingCompileCycles(document, addFailure, evidencePath) {
  const cycles = document?.cycles;
  const exact = cycles?.exact;
  if (!nativeCompileOperationValid(exact)
    || exact.exactMatch !== true
    || exact.codeChanged !== false) {
    addFailure(
      'invalid-exact-cycle',
      evidencePath,
      'The exact cycle must be a successful quick-fast compile operation with exactMatch=true and codeChanged=false.',
    );
  }

  const hotEdit = cycles?.hotEdit;
  if (!nativeCompileOperationValid(hotEdit)
    || hotEdit.exactMatch !== false
    || hotEdit.codeChanged !== true) {
    addFailure(
      'invalid-hot-edit-cycle',
      evidencePath,
      'The hot-edit cycle must be a successful quick-fast compile operation with exactMatch=false and codeChanged=true.',
    );
  }

  if (own(cycles, 'exactPriming') && !nativeCompileOperationValid(cycles.exactPriming)) {
    addFailure(
      'invalid-exact-priming-cycle',
      evidencePath,
      'When present, exactPriming must be a successful quick-fast compile operation with positive wallSeconds.',
    );
  }
}

function validateModeCompileProfileBinding(document, mode, baselineEnvironment, addFailure, evidencePath) {
  const expected = MODE_COMPILE_PROFILE_POLICY[mode];
  if (!expected) return;

  const coldProfile = normalizeCompileProfile(document?.cycles?.cold?.profile);
  if (coldProfile !== expected.cold) {
    addFailure(
      'cold-compile-profile-mode-mismatch',
      evidencePath,
      `${mode} cold compilation must report Compile Profile ${expected.cold}.`,
    );
  }

  const upload = document?.cycles?.upload;
  if (upload?.schemaId !== 'ck.native-compile-upload-operation'
    || upload?.schemaVersion !== 1
    || upload?.kind !== 'upload'
    || upload?.success !== true
    || typeof upload?.wallSeconds !== 'number'
    || !Number.isFinite(upload.wallSeconds)
    || upload.wallSeconds <= 0) {
    addFailure(
      'invalid-upload-cycle',
      evidencePath,
      'The upload cycle must be a successful schemaVersion=1 native operation with positive numeric wallSeconds.',
    );
    return;
  }
  const uploadProfile = normalizeCompileProfile(upload?.profile);
  const baselineProfile = normalizeCompileProfile(baselineEnvironment?.compileProfile);
  if (uploadProfile !== expected.upload
    || baselineProfile !== expected.upload
    || baselineProfile !== uploadProfile) {
    addFailure(
      'verified-upload-profile-mode-mismatch',
      evidencePath,
      `${mode} must contain a successful ${expected.upload} upload stage and a matching verified_baseline compileProfile.`,
    );
  }
}

function validateColdCycle(document, mode, addFailure, evidencePath) {
  const cold = document?.cycles?.cold;
  const seconds = cold?.wallSeconds;
  if (cold?.schemaId !== 'ck.native-compile-upload-operation'
    || cold?.schemaVersion !== 1
    || cold?.kind !== 'compile'
    || cold?.success !== true
    || typeof seconds !== 'number'
    || !Number.isFinite(seconds)
    || seconds <= 0) {
    addFailure(
      'invalid-cold-cycle',
      evidencePath,
      'The cold cycle must be a successful compile with a positive numeric wallSeconds value.',
    );
    return null;
  }
  if (cold.compileLockWaitReported !== true
    || typeof cold.compileLockSeconds !== 'number'
    || !Number.isFinite(cold.compileLockSeconds)
    || cold.compileLockSeconds < 0
    || cold.compileLockSeconds > 5
    || cold.matchingWarmupWaitObserved !== false
    || cold.compatibleWarmupReuseObserved !== false) {
    addFailure(
      'invalid-cold-lock-or-warmup-evidence',
      evidencePath,
      'Cold compile-lock telemetry must be explicitly reported within 0..5 seconds, without warmup waiting or reuse.',
    );
    return null;
  }
  if (mode === MODE_FIRST) {
    if (cold.fullBuild !== true || cold.exactMatch !== false) {
      addFailure(
        'invalid-first-project-cold',
        evidencePath,
        'firstProjectCold must be a verified Full Build and must not be Exact Match.',
      );
      return null;
    }
  } else if (mode === MODE_READY) {
    if (cold.fastRelink !== true
      || cold.fullBuild !== false
      || cold.exactMatch !== false
      || cold.prebuiltCoreInjected !== true
      || cold.syntheticCcdbPrepared !== true
      || cold.arduinoCliCcdbRefreshObserved !== false
    ) {
      addFailure(
        'invalid-ready-install-cold',
        evidencePath,
        'readyInstallCold must be non-Full, non-Exact Fast Relink with synthetic CCDB and no Arduino CLI CCDB refresh.',
      );
      return null;
    }
  }
  return round(seconds);
}

function improvementPercent(baseline, candidate) {
  if (!(baseline > 0) || !(candidate >= 0)) return null;
  return ((baseline - candidate) / baseline) * 100;
}

function evidenceLabel(record) {
  const raw = String(record?.relativePath || '<memory-input>').trim();
  const normalized = raw.replaceAll('\\', '/');
  if (!normalized
    || path.isAbsolute(raw)
    || /^[a-z]:[\\/]/i.test(raw)
    || /^\\\\/.test(raw)
    || normalized.split('/').includes('..')) return '<input-redacted>';
  return normalized;
}

function validatedOptions(options) {
  if (options == null) return { now: new Date() };
  if (typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('buildFirstCompileSummary options must be an object containing only now.');
  }
  const unknown = Object.keys(options).filter((key) => key !== 'now');
  if (unknown.length > 0) {
    throw new TypeError(`Unsupported policy override: ${unknown.join(', ')}.`);
  }
  if (own(options, 'now')) {
    if (!(options.now instanceof Date) || !Number.isFinite(options.now.getTime())) {
      throw new TypeError('options.now must be a valid Date.');
    }
    return { now: options.now };
  }
  return { now: new Date() };
}

function sampleId(mode, index, runId, evidencePath) {
  const digest = sha256Text(`${mode}\0${runId}\0${evidencePath}`).slice(0, 12);
  return `${mode}-${String(index + 1).padStart(2, '0')}-${digest}`;
}

function validateTemporalBatch(entries, now, addFailure) {
  if (entries.length !== REQUIRED_TEMPORAL_SEQUENCE.length) {
    return { spanSeconds: null, expiresAt: null };
  }
  const ordered = [...entries].sort((left, right) => (
    left.verifiedBeforeMillis - right.verifiedBeforeMillis
      || left.capturedMillis - right.capturedMillis
      || left.evidencePath.localeCompare(right.evidencePath, 'en')
  ));
  const actualSequence = ordered.map((entry) => entry.mode);
  if (actualSequence.some((mode, index) => mode !== REQUIRED_TEMPORAL_SEQUENCE[index])) {
    addFailure(
      'invalid-temporal-sample-sequence',
      null,
      'The six native samples must be captured strictly as First -> Ready -> First -> Ready -> First -> Ready.',
    );
  }
  if (ordered.slice(1).some((entry, index) => (
    ordered[index].verifiedAfterMillis > entry.verifiedBeforeMillis
  ))) {
    addFailure(
      'overlapping-temporal-samples',
      null,
      'Native benchmark verification windows must not overlap.',
    );
  }

  const spanMillis = ordered.at(-1).verifiedAfterMillis - ordered[0].verifiedBeforeMillis;
  const maximumSpanMillis = MAXIMUM_BATCH_SPAN_HOURS * 60 * 60 * 1000;
  if (!Number.isFinite(spanMillis) || spanMillis < 0 || spanMillis > maximumSpanMillis) {
    addFailure(
      'temporal-batch-span-exceeded',
      null,
      `The complete native 3+3 batch must finish within ${MAXIMUM_BATCH_SPAN_HOURS} hours.`,
    );
  }

  const nowMillis = now.getTime();
  const maximumAgeMillis = MAXIMUM_EVIDENCE_AGE_HOURS * 60 * 60 * 1000;
  const futureToleranceMillis = FUTURE_TIMESTAMP_TOLERANCE_MINUTES * 60 * 1000;
  if (ordered[0].verifiedBeforeMillis < nowMillis - maximumAgeMillis) {
    addFailure(
      'temporal-batch-stale',
      null,
      `Every native sample in the batch must be no older than ${MAXIMUM_EVIDENCE_AGE_HOURS} hours.`,
    );
  }
  if (ordered.at(-1).verifiedAfterMillis > nowMillis + futureToleranceMillis) {
    addFailure(
      'temporal-batch-from-future',
      null,
      `Native sample timestamps may be at most ${FUTURE_TIMESTAMP_TOLERANCE_MINUTES} minutes ahead of the summary clock.`,
    );
  }
  const expiresAtMillis = ordered[0].verifiedBeforeMillis + maximumAgeMillis;
  return {
    spanSeconds: Number.isFinite(spanMillis) && spanMillis >= 0 ? round(spanMillis / 1000) : null,
    expiresAt: Number.isFinite(expiresAtMillis) ? new Date(expiresAtMillis).toISOString() : null,
  };
}

export function buildFirstCompileSummary(records, options = {}) {
  const { now } = validatedOptions(options);
  const failures = [];
  const addFailure = (id, evidence, message) => {
    failures.push({ id, ...(evidence ? { evidence } : {}), message });
  };
  const samples = { [MODE_FIRST]: [], [MODE_READY]: [] };
  const temporalSamples = [];
  const seenRuns = new Set();
  let referenceBinding = null;
  let firstProjectBinding = null;
  const inputRecords = Array.isArray(records) ? records : [];
  const batchVerification = verifiedBatches.get(inputRecords);
  if (!batchVerification) {
    addFailure(
      'input-batch-not-loader-verified',
      null,
      'The exact input collection returned by loadBenchmarkRecords is required.',
    );
  } else {
    failures.push(...batchVerification.errors.map((error) => ({ ...error })));
  }

  for (const record of inputRecords) {
    const document = record?.document;
    const evidencePath = evidenceLabel(record);
    const failuresBefore = failures.length;
    const verification = record && typeof record === 'object' ? verifiedRecords.get(record) : null;
    if (!verification) {
      addFailure(
        'record-not-loader-verified',
        evidencePath,
        'The sample was not directly verified by loadBenchmarkRecords.',
      );
      continue;
    }
    if (documentFingerprint(document) !== verification.documentFingerprint) {
      addFailure(
        'verified-record-mutated',
        evidencePath,
        'The sample changed after direct-file verification.',
      );
      continue;
    }
    if (!document || typeof document !== 'object' || Array.isArray(document)) {
      addFailure('invalid-document', evidencePath, 'The input is not a Benchmark JSON object.');
      continue;
    }
    if (document.schemaId !== 'ck.native-compile-upload-benchmark'
      || document.schemaVersion !== 1
      || document.evidenceScope !== 'single-native-session') {
      addFailure(
        'invalid-benchmark-schema-or-scope',
        evidencePath,
        'Each input must be ck.native-compile-upload-benchmark schemaVersion=1 evidence from a single-native-session.',
      );
    }
    if (document.status !== 'passed') {
      addFailure('benchmark-status-not-passed', evidencePath, 'Benchmark status must be passed.');
    }
    validateBenchmarkOutcomeEnvelope(document, addFailure, evidencePath);
    validateSupportingCompileCycles(document, addFailure, evidencePath);
    const mode = document.coldMode;
    if (!MODES.includes(mode)) {
      addFailure(
        'unsupported-cold-mode',
        evidencePath,
        'Only firstProjectCold and readyInstallCold evidence is accepted.',
      );
    } else {
      validateCacheClearIdentity(document, mode, addFailure, evidencePath);
    }
    const runId = document.runId;
    if (!isNonEmptyString(runId)) {
      addFailure('missing-run-id', evidencePath, 'Benchmark runId is required.');
    } else {
      const normalizedRunId = runId.trim();
      if (seenRuns.has(normalizedRunId)) {
        addFailure(
          'duplicate-run-id',
          evidencePath,
          'A duplicate runId cannot increase the independent sample count.',
        );
      } else {
        seenRuns.add(normalizedRunId);
      }
    }

    const binding = bindingFromDocument(document, addFailure, evidencePath);
    if (MODES.includes(mode)) {
      validateModeCompileProfileBinding(
        document,
        mode,
        binding.environment,
        addFailure,
        evidencePath,
      );
    }
    if (referenceBinding == null && failures.length === failuresBefore) {
      referenceBinding = binding;
    } else if (referenceBinding != null && stableBinding(binding) !== stableBinding(referenceBinding)) {
      addFailure(
        'cross-sample-binding-mismatch',
        evidencePath,
        'FQBN, source, release files, production process, or verified upload environment differs across samples.',
      );
    }

    const seconds = MODES.includes(mode)
      ? validateColdCycle(document, mode, addFailure, evidencePath)
      : null;
    if (failures.length === failuresBefore && seconds != null) {
      if (mode === MODE_FIRST && firstProjectBinding == null) firstProjectBinding = binding;
      temporalSamples.push({
        mode,
        evidencePath,
        ...binding.sampleTemporal,
      });
      samples[mode].push({
        sampleId: sampleId(mode, samples[mode].length, runId.trim(), evidencePath),
        seconds,
      });
    }
  }

  for (const mode of MODES) {
    if (samples[mode].length !== MINIMUM_SAMPLES_PER_MODE) {
      addFailure(
        'invalid-sample-count',
        null,
        `${mode} requires exactly ${MINIMUM_SAMPLES_PER_MODE} independent valid samples; found ${samples[mode].length}.`,
      );
    }
  }
  const temporalBatch = validateTemporalBatch(temporalSamples, now, addFailure);

  const statistics = {
    [MODE_FIRST]: calculateStatistics(samples[MODE_FIRST].map((sample) => sample.seconds)),
    [MODE_READY]: calculateStatistics(samples[MODE_READY].map((sample) => sample.seconds)),
  };
  const medianRaw = statistics[MODE_FIRST] && statistics[MODE_READY]
    ? improvementPercent(
      statistics[MODE_FIRST].medianSeconds,
      statistics[MODE_READY].medianSeconds,
    )
    : null;
  const p95Raw = statistics[MODE_FIRST] && statistics[MODE_READY]
    ? improvementPercent(
      statistics[MODE_FIRST].p95Seconds,
      statistics[MODE_READY].p95Seconds,
    )
    : null;
  const medianTargetMet = medianRaw != null && medianRaw >= TARGET_IMPROVEMENT_PERCENT;
  const p95TargetMet = p95Raw != null && p95Raw >= TARGET_IMPROVEMENT_PERCENT;
  if (statistics[MODE_FIRST] && statistics[MODE_READY] && !medianTargetMet) {
    addFailure(
      'median-improvement-target-missed',
      null,
      `Median improvement did not reach ${TARGET_IMPROVEMENT_PERCENT}%.`,
    );
  }
  if (statistics[MODE_FIRST] && statistics[MODE_READY] && !p95TargetMet) {
    addFailure(
      'p95-improvement-target-missed',
      null,
      `Nearest-rank p95 improvement did not reach ${TARGET_IMPROVEMENT_PERCENT}%.`,
    );
  }

  return {
    schemaId: SUMMARY_SCHEMA_ID,
    schemaVersion: SUMMARY_SCHEMA_VERSION,
    status: failures.length === 0 ? 'passed' : 'failed',
    generatedAt: now.toISOString(),
    evidenceMode: 'direct-local-file-verification-no-build-executed',
    attestationBoundary: 'same-source-files-directly-verified-not-a-cryptographic-signer',
    policy: {
      minimumSamplesPerMode: MINIMUM_SAMPLES_PER_MODE,
      requireExactSamplesPerMode: true,
      maximumCompileLockSeconds: 5,
      percentileMethod: 'nearest-rank',
      targetImprovementPercent: TARGET_IMPROVEMENT_PERCENT,
      requireMedianAndP95: true,
      requireSuccessfulUploadBaseline: true,
      compileProfilesByColdMode: MODE_COMPILE_PROFILE_POLICY,
      cacheClearByColdMode: MODE_CACHE_CLEAR_POLICY,
      requiredTemporalSequence: REQUIRED_TEMPORAL_SEQUENCE,
      requireNonOverlappingSamples: true,
      requireGateExecutableSampleOrder: true,
      maximumBatchSpanHours: MAXIMUM_BATCH_SPAN_HOURS,
      maximumEvidenceAgeHours: MAXIMUM_EVIDENCE_AGE_HOURS,
      futureTimestampToleranceMinutes: FUTURE_TIMESTAMP_TOLERANCE_MINUTES,
    },
    batch: {
      spanSeconds: temporalBatch.spanSeconds,
      expiresAt: temporalBatch.expiresAt,
    },
    binding: publicBinding(firstProjectBinding || referenceBinding),
    samples,
    statistics,
    improvementPercent: {
      median: round(medianRaw, 2),
      p95: round(p95Raw, 2),
      medianTargetMet,
      p95TargetMet,
    },
    failures,
  };
}

function sourceIdentityFromGate(gate) {
  const identity = gate?.source_tree?.identity ?? gate?.sourceTree?.identity;
  const candidates = Array.isArray(identity) ? identity : identity ? [identity] : [];
  return candidates.filter((candidate) => (
    candidate && typeof candidate === 'object' && !Array.isArray(candidate)
  ));
}

async function verifyManifest(rootReal, reference, expectedSha256, expectedTreeSha256) {
  const identity = await sha256File(reference.absolutePath);
  if (identity.sha256 !== expectedSha256.toLowerCase()) {
    throw new EvidenceError('source-manifest-sha-mismatch', 'Source manifest bytes do not match the benchmark binding.');
  }
  const manifest = await readJsonReference(reference, 'source manifest');
  const files = manifest?.files;
  if (manifest?.schema_version !== 1
    || manifest?.policy_id !== 'ck-source-tree-v1'
    || manifest?.hash_algorithm !== 'sha256'
    || manifest?.source_control?.kind !== 'none'
    || manifest?.source_control?.commit != null
    || !Array.isArray(files)) {
    throw new EvidenceError('source-manifest-schema-invalid', 'Source manifest schema or no-Git policy is invalid.');
  }
  const seen = new Set();
  const rows = [];
  let totalBytes = 0;
  for (const file of files) {
    const relativeFile = normalizeRecordedRelativePath(file?.path, 'source manifest file');
    const key = normalizePathKey(relativeFile);
    if (seen.has(key)
      || !isNonNegativeSafeInteger(file?.bytes)
      || !isSha256(file?.sha256)) {
      throw new EvidenceError('source-manifest-entry-invalid', 'Source manifest contains a duplicate or invalid file entry.');
    }
    seen.add(key);
    const actualReference = await resolveRootFile(rootReal, relativeFile, 'source manifest file');
    const actualIdentity = await sha256File(actualReference.absolutePath);
    if (actualIdentity.bytes !== file.bytes
      || actualIdentity.sha256 !== file.sha256.toLowerCase()) {
      throw new EvidenceError('source-file-binding-mismatch', 'A source file no longer matches the frozen manifest.');
    }
    totalBytes += file.bytes;
    if (!Number.isSafeInteger(totalBytes)) {
      throw new EvidenceError('source-manifest-size-invalid', 'Source manifest total bytes exceed the safe integer range.');
    }
    rows.push(`${relativeFile}\t${file.bytes}\t${file.sha256.toLowerCase()}\n`);
  }
  rows.sort((left, right) => {
    const leftPath = left.slice(0, left.indexOf('\t'));
    const rightPath = right.slice(0, right.indexOf('\t'));
    return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0;
  });
  const calculatedTree = sha256Text(rows.join(''));
  if (!isNonNegativeSafeInteger(manifest.file_count)
    || manifest.file_count !== files.length
    || !isNonNegativeSafeInteger(manifest.total_bytes)
    || manifest.total_bytes !== totalBytes
    || !isSha256(manifest.tree_sha256)
    || manifest.tree_sha256.toLowerCase() !== calculatedTree
    || calculatedTree !== expectedTreeSha256.toLowerCase()) {
    throw new EvidenceError('source-manifest-tree-mismatch', 'Source manifest file list and tree identity are inconsistent.');
  }
  return { manifest, manifestSha256: identity.sha256, treeSha256: calculatedTree, totalBytes };
}

async function verifyReferenceBundle(document, rootReal, verificationCache) {
  const source = document?.source_tree || document?.sourceTree;
  const manifestPath = pick(source, 'manifest_path', 'manifestPath');
  const freezePath = pick(source, 'freeze_record_path', 'freezeRecordPath');
  const manifestSha256 = pick(source, 'manifest_sha256', 'manifestSha256');
  const freezeSha256 = pick(source, 'freeze_record_sha256', 'freezeRecordSha256');
  const treeSha256 = pick(source, 'tree_sha256', 'treeSha256');
  if (!isSha256(manifestSha256) || !isSha256(freezeSha256) || !isSha256(treeSha256)) {
    throw new EvidenceError('invalid-source-tree-binding', 'Benchmark source hashes are missing or invalid.');
  }
  const gate = document?.gate_run || document?.gateRun;
  const executable = document?.executable;
  const recordedGateFinishedAt = pick(gate, 'finished_at', 'finishedAt');
  const cacheKey = JSON.stringify({
    manifestPath,
    freezePath,
    manifestSha256: manifestSha256.toLowerCase(),
    freezeSha256: freezeSha256.toLowerCase(),
    treeSha256: treeSha256.toLowerCase(),
    gatePath: pick(gate, 'report_path', 'reportPath'),
    gateSha256: String(pick(gate, 'report_sha256', 'reportSha256') || '').toLowerCase(),
    gateRunId: pick(gate, 'run_id', 'runId'),
    gateFinishedAt: recordedGateFinishedAt,
    executablePath: executable?.path,
    executableSha256: String(executable?.sha256 || '').toLowerCase(),
    executableBytes: executable?.bytes,
  });
  if (verificationCache.has(cacheKey)) return;
  const manifestReference = await resolveRootFile(rootReal, manifestPath, 'source manifest path');
  const freezeReference = await resolveRootFile(rootReal, freezePath, 'source freeze path');
  const verifiedManifest = await verifyManifest(
    rootReal,
    manifestReference,
    manifestSha256,
    treeSha256,
  );

  const freezeIdentity = await sha256File(freezeReference.absolutePath);
  if (freezeIdentity.sha256 !== freezeSha256.toLowerCase()) {
    throw new EvidenceError('source-freeze-sha-mismatch', 'Source freeze bytes do not match the benchmark binding.');
  }
  const freeze = await readJsonReference(freezeReference, 'source freeze record');
  if (freeze?.schema_version !== 1
    || freeze?.policy_id !== 'ck-source-tree-v1'
    || freeze?.source_control?.kind !== 'none'
    || freeze?.source_control?.commit != null
    || normalizeRecordedRelativePath(freeze?.manifest_path, 'freeze manifest path') !== manifestReference.relativePath
    || String(freeze?.manifest_sha256 || '').toLowerCase() !== verifiedManifest.manifestSha256
    || String(freeze?.tree_sha256 || '').toLowerCase() !== verifiedManifest.treeSha256
    || freeze?.file_count !== verifiedManifest.manifest.file_count
    || freeze?.total_bytes !== verifiedManifest.totalBytes
    || !isNonEmptyString(freeze?.frozen_at)
    || !Number.isFinite(Date.parse(freeze.frozen_at))) {
    throw new EvidenceError('source-freeze-binding-mismatch', 'Source freeze record is inconsistent with the manifest.');
  }

  const gatePath = pick(gate, 'report_path', 'reportPath');
  const gateSha256 = pick(gate, 'report_sha256', 'reportSha256');
  const gateReference = await resolveRootFile(rootReal, gatePath, 'release gate report path');
  const gateIdentity = await sha256File(gateReference.absolutePath);
  if (!isSha256(gateSha256) || gateIdentity.sha256 !== gateSha256.toLowerCase()) {
    throw new EvidenceError('gate-report-sha-mismatch', 'Release gate bytes do not match the benchmark binding.');
  }
  const gateDocument = await readJsonReference(gateReference, 'release gate report');
  const gateSource = sourceIdentityFromGate(gateDocument);
  const recordedGateRunId = pick(gate, 'run_id', 'runId');
  if (parseEvidenceTimestamp(recordedGateFinishedAt) == null
    || parseEvidenceTimestamp(gateDocument?.finished_at) == null
    || gateDocument.finished_at !== recordedGateFinishedAt) {
    throw new EvidenceError(
      'gate-report-finished-at-mismatch',
      'Benchmark gate finished_at must exactly match the referenced release gate report.',
    );
  }
  if (gate?.status !== 'passed'
    || gateDocument?.status !== 'passed'
    || !isNonEmptyString(recordedGateRunId)
    || gateDocument?.run_id !== recordedGateRunId
    || gateSource.length !== 1
    || gateDocument?.source_tree?.verified_before_gate !== true
    || gateDocument?.source_tree?.verified_after_gate !== true
    || String(gateSource[0].manifest_sha256 || '').toLowerCase() !== verifiedManifest.manifestSha256
    || String(gateSource[0].tree_sha256 || '').toLowerCase() !== verifiedManifest.treeSha256
    || normalizeRecordedRelativePath(gateSource[0].manifest_path, 'gate manifest path') !== manifestReference.relativePath
    || normalizeRecordedRelativePath(gateSource[0].freeze_record_path, 'gate freeze path') !== freezeReference.relativePath
    || gateSource[0].frozen_at !== freeze.frozen_at) {
    throw new EvidenceError('gate-report-binding-mismatch', 'Release gate is not a passed run for the same source freeze.');
  }

  const executableReference = await resolveRootFile(rootReal, executable?.path, 'production executable path');
  const executableIdentity = await sha256File(executableReference.absolutePath);
  if (!isSha256(executable?.sha256)
    || executableIdentity.sha256 !== executable.sha256.toLowerCase()
    || !isPositiveSafeInteger(executable?.bytes)
    || executableIdentity.bytes !== executable.bytes) {
    throw new EvidenceError('production-executable-binding-mismatch', 'Production executable hash or byte size does not match.');
  }
  verificationCache.set(cacheKey, true);
}

function safeInputLabel(candidate, rootReal, index) {
  const relative = path.relative(rootReal, candidate);
  if (relative && pathIsWithin(rootReal, candidate)) return relative.split(path.sep).join('/');
  return `<rejected-input-${String(index).padStart(3, '0')}>`;
}

async function resolveInputCandidate(rootReal, value, index) {
  if (!isNonEmptyString(value)) {
    throw new EvidenceError('input-path-invalid', 'Benchmark input path is empty.');
  }
  const raw = value.trim();
  const candidate = path.isAbsolute(raw) || /^[a-z]:[\\/]/i.test(raw) || /^\\\\/.test(raw)
    ? path.resolve(raw)
    : path.resolve(rootReal, ...raw.replaceAll('\\', '/').split('/'));
  if (!pathIsWithin(rootReal, candidate)) {
    throw new EvidenceError('input-path-escape', 'Benchmark input must stay inside --root.');
  }
  let candidateReal;
  try {
    candidateReal = await realpath(candidate);
  } catch {
    throw new EvidenceError('input-file-missing', 'Benchmark input does not exist.');
  }
  if (!pathIsWithin(rootReal, candidateReal)) {
    throw new EvidenceError('input-realpath-escape', 'Benchmark input resolves outside --root.');
  }
  const metadata = await stat(candidateReal);
  const linkMetadata = await lstat(candidate);
  if (linkMetadata.isSymbolicLink() || !metadata.isFile()) {
    throw new EvidenceError('input-not-regular-file', 'Benchmark input must be a regular file.');
  }
  return {
    absolutePath: candidateReal,
    relativePath: safeInputLabel(candidateReal, rootReal, index),
    metadata,
  };
}

export async function loadBenchmarkRecords({
  inputPaths = [],
  inputDirectory = '',
  root = process.cwd(),
}) {
  const rootPath = path.resolve(root);
  const rootReal = await realpath(rootPath);
  const rawCandidates = [...inputPaths];
  const errors = [];
  if (inputDirectory) {
    try {
      const raw = inputDirectory.trim();
      const directoryCandidate = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(rootReal, raw);
      const directoryReal = await realpath(directoryCandidate);
      if (!pathIsWithin(rootReal, directoryReal)) {
        throw new EvidenceError('input-directory-escape', 'Input directory must stay inside --root.');
      }
      const entries = await readdir(directoryReal, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) {
          rawCandidates.push(path.join(directoryReal, entry.name));
        }
      }
    } catch (error) {
      errors.push({
        id: error instanceof EvidenceError ? error.id : 'input-directory-read-failed',
        evidence: '<input-directory>',
        message: error instanceof EvidenceError ? error.message : 'Unable to read input directory.',
      });
    }
  }

  const resolved = [];
  for (let index = 0; index < rawCandidates.length; index += 1) {
    const rawCandidate = rawCandidates[index];
    try {
      resolved.push(await resolveInputCandidate(rootReal, rawCandidate, index + 1));
    } catch (error) {
      errors.push({
        id: error instanceof EvidenceError ? error.id : 'input-read-failed',
        evidence: `<rejected-input-${String(index + 1).padStart(3, '0')}>`,
        message: error instanceof EvidenceError ? error.message : 'Unable to resolve benchmark input.',
      });
    }
  }
  const unique = [...new Map(
    resolved.map((candidate) => [normalizePathKey(candidate.absolutePath), candidate]),
  ).values()].sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en'));

  const records = [];
  const verificationCache = new Map();
  for (const candidate of unique) {
    try {
      if (candidate.metadata.size <= 0 || candidate.metadata.size > MAX_INPUT_BYTES) {
        throw new EvidenceError(
          'input-size-invalid',
          `File size must be between 1 and ${MAX_INPUT_BYTES} bytes.`,
        );
      }
      const document = JSON.parse(await readFile(candidate.absolutePath, 'utf8'));
      if (document?.schemaId === SUMMARY_SCHEMA_ID) continue;
      await verifyReferenceBundle(document, rootReal, verificationCache);
      const record = { relativePath: candidate.relativePath, document };
      verifiedRecords.set(record, { documentFingerprint: documentFingerprint(document) });
      records.push(record);
    } catch (error) {
      errors.push({
        id: error instanceof EvidenceError ? error.id : 'input-read-failed',
        evidence: candidate.relativePath,
        message: error instanceof EvidenceError
          ? error.message
          : `Unable to read, parse, or verify benchmark input (${String(error?.code || error?.name || 'error')}).`,
      });
    }
  }
  verifiedBatches.set(records, { errors: errors.map((error) => ({ ...error })) });
  return { records, errors };
}

export async function writeJsonAtomic(outputPath, value) {
  const destination = path.resolve(outputPath);
  const directory = path.dirname(destination);
  await mkdir(directory, { recursive: true });
  const temporary = path.join(
    directory,
    `.${path.basename(destination)}.tmp-${process.pid}-${Date.now()}`,
  );
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function parseArguments(argv) {
  const options = {
    inputPaths: [],
    inputDirectory: '',
    root: process.cwd(),
    output: '',
    strict: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = () => {
      const value = argv[++index];
      if (!value) throw new Error(`${token} requires a value`);
      return value;
    };
    if (token === '--input') options.inputPaths.push(next());
    else if (token === '--input-dir') options.inputDirectory = next();
    else if (token === '--root') options.root = next();
    else if (token === '--output') options.output = next();
    else if (token === '--strict') options.strict = true;
    else throw new Error(`Unknown argument: ${token}`);
  }
  if (options.inputPaths.length === 0 && !options.inputDirectory) {
    throw new Error('At least one --input or --input-dir is required.');
  }
  if (!options.output) throw new Error('--output is required.');
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const loaded = await loadBenchmarkRecords(options);
  const summary = buildFirstCompileSummary(loaded.records);
  await writeJsonAtomic(options.output, summary);
  process.stdout.write(
    `first-compile performance: ${summary.status}; first=${summary.statistics.firstProjectCold?.medianSeconds ?? 'n/a'}s median; ready=${summary.statistics.readyInstallCold?.medianSeconds ?? 'n/a'}s median\n`,
  );
  return options.strict && summary.status !== 'passed' ? 1 : 0;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    process.stderr.write(`${String(error?.stack || error)}\n`);
    process.exitCode = 1;
  });
}
