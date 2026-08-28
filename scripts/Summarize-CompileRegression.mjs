#!/usr/bin/env node

import { readFile, readdir, stat, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SUMMARY_SCHEMA_ID = 'ck.compile-regression-summary';
export const BENCHMARK_SCHEMA_ID = 'ck.native-compile-upload-benchmark';
export const OPERATION_SCHEMA_ID = 'ck.native-compile-upload-operation';
export const UPLOAD_PROGRESS_SCHEMA_ID = 'ck.native-upload-progress';
export const ARTIFACT_GATE_SCHEMA_ID = 'ck.native-upload-manifest-gate';
export const STAGES = ['cold', 'exact', 'hotEdit', 'upload', 'artifactGate'];
export const DEFAULT_TARGETS = [
  { id: 'esp32-c3', label: 'ESP32-C3' },
  { id: 'esp32-c5', label: 'ESP32-C5' },
  { id: 'esp32-c6', label: 'ESP32-C6' },
  { id: 'esp32-s3', label: 'ESP32-S3' },
  { id: 'avr', label: 'Arduino AVR' },
];

const STATUS_LABELS = {
  passed: '通过',
  failed: '失败',
  skipped: '跳过',
  missing: '缺失',
};

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

const FQBN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const FQBN_VALUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.+@/-]*$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;

function parseFqbn(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  const parts = raw.split(':');
  if (parts.length !== 3 && parts.length !== 4) return null;
  const base = parts.slice(0, 3);
  if (!base.every((part) => FQBN_ID_PATTERN.test(part))) return null;
  const options = [];
  const seenKeys = new Set();
  if (parts.length === 4) {
    if (!parts[3]) return null;
    for (const rawOption of parts[3].split(',')) {
      const option = rawOption.trim();
      const separator = option.indexOf('=');
      if (separator <= 0 || separator !== option.lastIndexOf('=')) return null;
      const key = option.slice(0, separator).trim();
      const optionValue = option.slice(separator + 1).trim();
      if (!FQBN_ID_PATTERN.test(key) || !FQBN_VALUE_PATTERN.test(optionValue)) return null;
      const normalizedKey = key.toLowerCase();
      if (seenKeys.has(normalizedKey)) return null;
      seenKeys.add(normalizedKey);
      options.push({ key, normalizedKey, value: optionValue });
    }
  }
  options.sort((left, right) => (
    left.normalizedKey.localeCompare(right.normalizedKey, 'en')
    || left.value.localeCompare(right.value, 'en')
  ));
  const canonical = [
    ...base.map((part) => part.toLowerCase()),
    ...(options.length ? [options.map((option) => `${option.key}=${option.value}`).join(',')] : []),
  ].join(':');
  return {
    canonical,
    base: base.map((part) => part.toLowerCase()).join(':'),
  };
}

export function canonicalizeFqbn(value) {
  return parseFqbn(value)?.canonical || '';
}

export function targetIdFromFqbn(value) {
  const base = parseFqbn(value)?.base;
  if (!base) return null;
  if (base === 'esp32:esp32:esp32c3') return 'esp32-c3';
  if (base === 'esp32:esp32:esp32c5') return 'esp32-c5';
  if (base === 'esp32:esp32:esp32c6') return 'esp32-c6';
  if (base === 'esp32:esp32:esp32s3') return 'esp32-s3';
  if (base.startsWith('arduino:avr:')) return 'avr';
  return null;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function sha256(value) {
  return typeof value === 'string' && SHA256_PATTERN.test(value) ? value.toLowerCase() : null;
}

function positiveSafeInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function property(value, ...names) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(value, name)) return value[name];
  }
  return undefined;
}

function parseEvidenceTimestamp(value) {
  if (typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    return null;
  }
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? millis : null;
}

function normalizeEvidenceBinding(document) {
  const source = property(document, 'source_tree', 'sourceTree');
  const gate = property(document, 'gate_run', 'gateRun');
  const executable = property(document, 'executable');
  const cdp = property(document, 'cdp_binding', 'cdpBinding');
  const verification = property(document, 'binding_verification', 'bindingVerification');
  const manifestSha256 = sha256(property(source, 'manifest_sha256', 'manifestSha256'));
  const freezeRecordSha256 = sha256(property(source, 'freeze_record_sha256', 'freezeRecordSha256'));
  const treeSha256 = sha256(property(source, 'tree_sha256', 'treeSha256'));
  const gateRunId = property(gate, 'run_id', 'runId');
  const gateReportSha256 = sha256(property(gate, 'report_sha256', 'reportSha256'));
  const executableSha256 = sha256(property(executable, 'sha256'));
  const executableBytes = positiveSafeInteger(property(executable, 'bytes'));
  const executableProcessId = positiveSafeInteger(property(executable, 'process_id', 'processId'));
  const executableStartedAt = property(executable, 'process_started_at', 'processStartedAt');
  const cdpProcessId = positiveSafeInteger(property(cdp, 'process_id', 'processId'));
  const cdpExecutableSha256 = sha256(property(
    cdp,
    'executable_sha256',
    'executableSha256',
    'production_executable_sha256',
    'productionExecutableSha256',
  ));
  const cdpBrowserProcessId = positiveSafeInteger(property(cdp, 'browser_process_id', 'browserProcessId'));
  const cdpTargetId = property(cdp, 'target_id', 'targetId');
  const verificationSchema = property(verification, 'schema_version', 'schemaVersion');
  const verifiedBeforeAt = property(verification, 'verified_before_at', 'verifiedBeforeAt');
  const verifiedAfterAt = property(verification, 'verified_after_at', 'verifiedAfterAt');
  const beforeMillis = parseEvidenceTimestamp(verifiedBeforeAt);
  const afterMillis = parseEvidenceTimestamp(verifiedAfterAt);
  if (!manifestSha256 || !freezeRecordSha256 || !treeSha256
    || property(gate, 'status') !== 'passed'
    || !nonEmptyString(gateRunId) || !gateReportSha256
    || !executableSha256 || !executableBytes || !executableProcessId
    || parseEvidenceTimestamp(executableStartedAt) === null
    || property(cdp, 'bound') !== true
    || cdpProcessId !== executableProcessId
    || cdpExecutableSha256 !== executableSha256
    || !cdpBrowserProcessId || !nonEmptyString(cdpTargetId)
    || verificationSchema !== 1 || property(verification, 'unchanged') !== true
    || beforeMillis === null || afterMillis === null || afterMillis < beforeMillis) {
    return null;
  }
  const normalized = {
    source: { manifestSha256, freezeRecordSha256, treeSha256 },
    gate: { runId: gateRunId.trim(), reportSha256: gateReportSha256 },
    executable: {
      sha256: executableSha256,
      bytes: executableBytes,
      processId: executableProcessId,
      startedAt: executableStartedAt,
    },
    cdp: {
      processId: cdpProcessId,
      browserProcessId: cdpBrowserProcessId,
      targetId: cdpTargetId.trim(),
    },
  };
  return { normalized, key: JSON.stringify(normalized) };
}

function canonicalProjectName(value) {
  if (!nonEmptyString(value)) return null;
  return value.trim().replace(/\.maker$/i, '').toLowerCase();
}

function benchmarkWorkspaceIdentity(document) {
  const project = canonicalProjectName(document?.project);
  const initial = document?.sourceGate?.initial;
  const restored = document?.sourceGate?.restored;
  if (!project
    || !nonEmptyString(initial?.codeFingerprint)
    || typeof initial?.includeSignature !== 'string'
    || restored?.codeFingerprint !== initial.codeFingerprint
    || restored?.includeSignature !== initial.includeSignature) {
    return null;
  }
  const normalized = {
    project,
    codeFingerprint: initial.codeFingerprint.trim(),
    includeSignature: initial.includeSignature.trim().toLowerCase(),
  };
  return { normalized, key: JSON.stringify(normalized) };
}

function gateWorkspaceIdentity(document) {
  const before = document?.identity?.before;
  const after = document?.identity?.after;
  const project = canonicalProjectName(document?.project);
  const identityProject = canonicalProjectName(before?.project);
  if (!project || identityProject !== project
    || document?.identity?.unchanged !== true
    || !nonEmptyString(before?.codeFingerprint)
    || typeof before?.includeSignature !== 'string'
    || canonicalizeFqbn(before?.fqbn) !== canonicalizeFqbn(document?.fqbn)
    || before?.port !== document?.port
    || canonicalProjectName(after?.project) !== identityProject
    || after?.codeFingerprint !== before.codeFingerprint
    || after?.includeSignature !== before.includeSignature
    || canonicalizeFqbn(after?.fqbn) !== canonicalizeFqbn(before?.fqbn)
    || after?.port !== before.port) {
    return null;
  }
  const normalized = {
    project,
    codeFingerprint: before.codeFingerprint.trim(),
    includeSignature: before.includeSignature.trim().toLowerCase(),
  };
  return { normalized, key: JSON.stringify(normalized) };
}

function documentKind(document) {
  if (document?.schemaId === BENCHMARK_SCHEMA_ID) return 'benchmark';
  if (document?.schemaId === UPLOAD_PROGRESS_SCHEMA_ID) return 'uploadProgress';
  if (document?.schemaId === ARTIFACT_GATE_SCHEMA_ID) return 'artifactGate';
  return null;
}

function validateProgressEnvelope(document) {
  const samples = document?.samples;
  return document?.schemaVersion === 1
    && document?.status === 'passed'
    && document?.success === true
    && nonEmptyString(document?.benchmarkRunId)
    && Array.isArray(document?.failures)
    && document.failures.length === 0
    && typeof document?.sampleCount === 'number'
    && Number.isSafeInteger(document.sampleCount)
    && document.sampleCount > 0
    && Array.isArray(samples)
    && samples.length === document.sampleCount
    && document?.valuesBounded === true
    && document?.integerPercentages === true
    && document?.monotonic === true
    && document?.hasTwoDigitPercentage === true
    && document?.finalPercentageIs100 === true
    && document?.percentageTextComplete === true
    && document?.percentageTextFits === true;
}

function validateArtifactGateEnvelope(document) {
  const gate = document?.gate;
  const hashGate = document?.hashGate;
  const restoration = document?.restoration;
  const hashRestoration = document?.hashRestoration;
  const allTrue = (object, names) => names.every((name) => object?.[name] === true);
  return document?.schemaVersion === 2
    && document?.status === 'passed'
    && nonEmptyString(document?.project)
    && nonEmptyString(document?.port)
    && allTrue(gate, [
      'exactMatchBeforeRejection',
      'fqbnMismatchRejected',
      'transportBlockedUntilRejection',
      'sharedFastFreshBuild',
      'sharedFastManifestVerified',
      'transportRevalidated',
      'transportObservedAfterRevalidation',
      'ordinaryUploadSucceeded',
      'allTargetFqbnsExact',
    ])
    && allTrue(hashGate, [
      'exactMatchBeforeRejection',
      'artifactHashMismatchRejected',
      'transportBlockedUntilHashRejection',
      'sharedFastFreshBuild',
      'sharedFastManifestVerified',
      'transportRevalidated',
      'transportObservedAfterRevalidation',
      'ordinaryUploadSucceeded',
      'allTargetFqbnsExact',
    ])
    && nonEmptyString(hashGate?.artifactRole)
    && allTrue(restoration, [
      'requested', 'completed', 'valid', 'originalHashRestored', 'backupRemoved', 'residueRemoved',
    ])
    && allTrue(hashRestoration, [
      'requested', 'completed', 'valid', 'originalHashRestored', 'backupRemoved', 'residueRemoved',
    ]);
}

function analyzeEvidenceRecord(record, now, maxAgeHours, strictFreshness) {
  const kind = documentKind(record.document);
  if (!kind) return null;
  const failures = [];
  const parsedFqbn = parseFqbn(record.document?.fqbn);
  if (!parsedFqbn) failures.push('invalid or malformed full FQBN');
  const capturedAt = record.document?.capturedAt;
  const captured = parseEvidenceTimestamp(capturedAt);
  let freshness = 'unknown';
  if (captured === null) {
    failures.push('capturedAt must be an ISO-8601 timestamp with an explicit timezone');
  } else if (captured > now.getTime()) {
    freshness = 'future';
    failures.push('capturedAt is in the future');
  } else {
    freshness = (now.getTime() - captured) / 3_600_000 <= maxAgeHours ? 'fresh' : 'stale';
    if (strictFreshness && freshness === 'stale') failures.push('evidence is stale in Strict mode');
  }
  const binding = normalizeEvidenceBinding(record.document);
  if (!binding) failures.push('native evidence binding envelope is incomplete or inconsistent');
  let workspaceIdentity = null;
  if (kind === 'benchmark') {
    if (record.document?.schemaVersion !== 1
      || record.document?.status !== 'passed'
      || record.document?.evidenceScope !== 'single-native-session'
      || !nonEmptyString(record.document?.runId)) {
      failures.push('benchmark schema, scope, status, or runId is invalid');
    }
    workspaceIdentity = benchmarkWorkspaceIdentity(record.document);
    if (!workspaceIdentity) failures.push('benchmark project/source/include identity is incomplete or not restored');
  } else if (kind === 'uploadProgress') {
    if (!validateProgressEnvelope(record.document)
      || !canonicalProjectName(record.document?.project)
      || !nonEmptyString(record.document?.port)) {
      failures.push('upload-progress schema or deterministic progress assertions are invalid');
    }
  } else if (kind === 'artifactGate') {
    if (!validateArtifactGateEnvelope(record.document)) {
      failures.push('artifact-gate schema or deterministic gate assertions are invalid');
    }
    workspaceIdentity = gateWorkspaceIdentity(record.document);
    if (!workspaceIdentity) failures.push('artifact-gate project/source/include identity is incomplete or changed');
  }
  return {
    record,
    kind,
    parsedFqbn,
    capturedAt,
    freshness,
    binding,
    workspaceIdentity,
    failures,
    valid: failures.length === 0,
  };
}

function capturedMillis(record) {
  const millis = Date.parse(record.document?.capturedAt || record.document?.completedAt || '');
  return Number.isFinite(millis) ? millis : Number.NEGATIVE_INFINITY;
}

function newest(records) {
  return [...records].sort((left, right) => {
    const timeDelta = capturedMillis(right) - capturedMillis(left);
    return timeDelta || right.relativePath.localeCompare(left.relativePath, 'en');
  })[0] || null;
}

function evidenceReference(record, now, maxAgeHours) {
  if (!record) return null;
  const capturedAt = record.document?.capturedAt || record.document?.completedAt || null;
  const millis = Date.parse(capturedAt || '');
  let ageHours = null;
  let freshness = 'unknown';
  if (Number.isFinite(millis)) {
    ageHours = Number(((now.getTime() - millis) / 3_600_000).toFixed(1));
    if (ageHours < -0.1) freshness = 'future';
    else if (ageHours <= maxAgeHours) freshness = 'fresh';
    else freshness = 'stale';
  }
  return {
    path: record.relativePath,
    capturedAt,
    ageHours,
    freshness,
    evidenceMode: 'imported-evidence',
    sameInvocationAsSummary: false,
  };
}

function skippedEntry(document, stage) {
  const entries = Array.isArray(document?.skippedStages) ? document.skippedStages : [];
  const matched = entries.find((entry) => (
    typeof entry === 'string' ? entry === stage : entry?.stage === stage
  ));
  if (!matched) return null;
  return {
    reason: typeof matched === 'string' ? 'recorded by evidence producer' : String(matched.reason || 'recorded by evidence producer'),
  };
}

function stageResult(status, details, source = null) {
  return {
    status,
    ...(details ? { details } : {}),
    ...(source ? { source } : {}),
  };
}

function preservationState(value) {
  if (value === true) return 'preserved';
  if (value === false) return 'cleared';
  return 'unknown';
}

function enabledState(value) {
  if (value === true) return 'enabled';
  if (value === false) return 'disabled';
  return 'unknown';
}

export function extractColdCacheReset(document, cycle) {
  const report = document?.cacheReset || document?.cacheClear || null;
  const reportFqbn = report?.fqbn || null;
  const documentFqbn = document?.fqbn || null;
  const sameFullFqbn = reportFqbn && documentFqbn
    ? canonicalizeFqbn(reportFqbn) === canonicalizeFqbn(documentFqbn)
    : false;
  const evidenceText = Array.isArray(cycle?.evidence) ? cycle.evidence.join('\n') : '';
  const forceRecacheFromLog = /CCACHE_RECACHE|ccache will be refreshed|bypassing existing ccache hits/i.test(evidenceText)
    || cycle?.forceCcacheRecacheObserved === true;
  const forcedRebuildFromLog = /Forced rebuild/i.test(evidenceText)
    || cycle?.forcedRebuildObserved === true;
  const prebuiltReuseFromLog = /Core cache injected directly from prebuilt_cores repository/i.test(evidenceText)
    || cycle?.prebuiltCoreInjected === true;
  const explicitScope = report?.reset_scope || report?.resetScope || null;
  const ccachePreserved = report?.ccache_store_preserved ?? report?.ccacheStorePreserved;
  const prebuiltPreserved = report?.prebuilt_core_preserved ?? report?.prebuiltCorePreserved;
  const explicitForceRecache = report?.force_ccache_recache ?? report?.forceCcacheRecache;
  return {
    scope: explicitScope || (sameFullFqbn ? 'exact-full-fqbn' : 'unknown'),
    requested: report ? true : 'unknown',
    targetFqbn: reportFqbn,
    removedEntries: finiteNumber(report?.removed_entries ?? report?.removedEntries),
    removedBytes: finiteNumber(report?.removed_bytes ?? report?.removedBytes),
    forceRebuildPending: typeof report?.force_rebuild_pending === 'boolean'
      ? report.force_rebuild_pending
      : typeof report?.forceRebuildPending === 'boolean'
        ? report.forceRebuildPending
        : forcedRebuildFromLog
          ? true
          : 'unknown',
    ccacheStore: preservationState(ccachePreserved),
    prebuiltCore: preservationState(prebuiltPreserved),
    forceCcacheRecache: enabledState(
      typeof explicitForceRecache === 'boolean'
        ? explicitForceRecache
        : forceRecacheFromLog
          ? true
          : null,
    ),
    prebuiltCoreReusedAfterReset: prebuiltReuseFromLog ? true : 'unknown',
    evidence: [
      ...(sameFullFqbn ? ['cache-clear report targets the exact full FQBN'] : []),
      ...(forceRecacheFromLog ? ['compile log explicitly observed forced ccache recache'] : []),
      ...(prebuiltReuseFromLog ? ['compile log explicitly observed prebuilt core injection'] : []),
    ],
  };
}

function evaluateCompileCycle(stage, cycle, source) {
  if (cycle?.status === 'skipped') {
    return stageResult('skipped', { reason: String(cycle.reason || 'recorded by evidence producer') }, source);
  }
  if (!cycle) return stageResult('missing', { reason: 'cycle is absent from the selected single-session report' });
  const seconds = finiteNumber(cycle.wallSeconds);
  const common = {
    seconds,
    reportedSeconds: finiteNumber(cycle.reportedSeconds),
    profile: cycle.profile || null,
  };
  if (cycle.status === 'failed' || cycle.success !== true) {
    return stageResult('failed', { ...common, reason: String(cycle.reason || cycle.error || 'cycle reported failure') }, source);
  }
  let valid = cycle.schemaId === OPERATION_SCHEMA_ID
    && cycle.schemaVersion === 1
    && cycle.kind === 'compile'
    && seconds !== null
    && seconds > 0;
  let reason = '';
  if (stage === 'cold') {
    valid = valid && cycle.fullBuild === true && cycle.exactMatch === false;
    reason = 'cold evidence must explicitly be a successful Full Build with exactMatch=false';
  } else if (stage === 'exact') {
    valid = valid && cycle.exactMatch === true && cycle.fullBuild === false;
    reason = 'exact evidence must explicitly report exactMatch=true and fullBuild=false';
  } else if (stage === 'hotEdit') {
    valid = valid && cycle.codeChanged === true && cycle.exactMatch === false;
    reason = 'hot-edit evidence must explicitly report codeChanged=true and exactMatch=false';
    common.fastRelink = cycle.fastRelink === true;
    common.improvementPercent = null;
  }
  return stageResult(valid ? 'passed' : 'failed', {
    ...common,
    ...(valid ? {} : { reason }),
  }, source);
}

function evaluateUpload(cycle, progressDocument, cycleSource, progressSource) {
  if (cycle?.status === 'skipped') {
    return stageResult('skipped', { reason: String(cycle.reason || 'recorded by evidence producer') }, cycleSource);
  }
  if (cycle) {
    const seconds = finiteNumber(cycle.wallSeconds);
    const valid = cycle.schemaId === OPERATION_SCHEMA_ID
      && cycle.schemaVersion === 1
      && cycle.kind === 'upload'
      && cycle.success === true
      && cycle.status !== 'failed'
      && seconds !== null
      && seconds > 0;
    return stageResult(valid ? 'passed' : 'failed', {
      seconds,
      transportSeconds: finiteNumber(cycle.uploadTransportSeconds),
      manifestVerified: typeof cycle.manifestVerified === 'boolean' ? cycle.manifestVerified : 'unknown',
      dedicatedProgressReport: progressDocument
        ? (progressDocument.success === true ? 'passed' : 'failed')
        : 'missing',
      ...(valid ? {} : { reason: 'upload cycle lacks an explicit successful native-operation envelope' }),
    }, cycleSource);
  }
  if (progressDocument) {
    const valid = progressDocument.success === true;
    return stageResult(valid ? 'passed' : 'failed', {
      seconds: finiteNumber(progressDocument.operationWallSeconds),
      manifestVerified: progressDocument.manifestVerified ?? null,
      reason: valid
        ? 'upload was proven by a dedicated progress report; no upload cycle was present'
        : String(progressDocument.failures?.join(' ') || 'dedicated upload report failed'),
    }, progressSource);
  }
  return stageResult('missing', { reason: 'no upload cycle or dedicated upload report for the selected FQBN' });
}

function evaluateArtifactGate(document, source) {
  if (!document) return stageResult('missing', { reason: 'no dedicated artifact-gate report for the selected FQBN' });
  const skipped = skippedEntry(document, 'artifactGate');
  if (skipped) return stageResult('skipped', skipped, source);
  const passed = documentKind(document) === 'artifactGate' && validateArtifactGateEnvelope(document);
  return stageResult(passed ? 'passed' : 'failed', {
    reason: passed
      ? 'dedicated FQBN and artifact-hash tamper/recovery gate report'
      : 'artifact-gate schema or deterministic assertions were not satisfied',
  }, source);
}

function computeBoardStatus(stages) {
  const statuses = Object.values(stages).map((stage) => stage.status);
  if (statuses.includes('failed')) return 'failed';
  if (statuses.includes('missing') || statuses.includes('skipped')) return 'incomplete';
  return 'complete';
}

function newestAnalysis(analyses) {
  const record = newest(analyses.map((analysis) => analysis.record));
  return record ? analyses.find((analysis) => analysis.record === record) || null : null;
}

function looksLikeLegacyRegressionEvidence(document) {
  return Boolean(document && typeof document === 'object' && (
    document.cycles
    || document.uploadProgress
    || document.artifactGate
    || document.gate
    || document.hashGate
    || document.finalQuickFastValidation
  ));
}

export function buildSummary(records, {
  now = new Date(),
  maxAgeHours = 168,
  sourceErrors = [],
  strictFreshness = false,
} = {}) {
  if (!Array.isArray(records)) throw new TypeError('records must be an array');
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new TypeError('now must be a valid Date');
  if (typeof maxAgeHours !== 'number' || !Number.isFinite(maxAgeHours) || maxAgeHours < 0) {
    throw new TypeError('maxAgeHours must be a non-negative finite number');
  }
  if (!Array.isArray(sourceErrors)) throw new TypeError('sourceErrors must be an array');
  if (typeof strictFreshness !== 'boolean') throw new TypeError('strictFreshness must be a boolean');
  const analyses = records
    .map((record) => analyzeEvidenceRecord(record, now, maxAgeHours, strictFreshness))
    .filter(Boolean);
  const validationErrors = analyses
    .filter((analysis) => !analysis.valid)
    .map((analysis) => ({
      path: analysis.record.relativePath,
      error: analysis.failures.join('; '),
    }));
  const validAnalyses = analyses.filter((analysis) => analysis.valid);
  const combinedSourceErrors = [...sourceErrors, ...validationErrors];
  const boards = DEFAULT_TARGETS.map((target) => {
    const targetAnalyses = validAnalyses.filter((analysis) => (
      targetIdFromFqbn(analysis.record.document?.fqbn) === target.id
    ));
    const cycleAnalysis = newestAnalysis(targetAnalyses.filter((analysis) => analysis.kind === 'benchmark'));
    const cycleRecord = cycleAnalysis?.record || null;
    const fqbn = cycleRecord?.document?.fqbn || null;
    const canonicalFqbn = canonicalizeFqbn(fqbn);
    const sameConfiguration = cycleAnalysis
      ? targetAnalyses.filter((analysis) => analysis.parsedFqbn.canonical === canonicalFqbn)
      : [];
    const sameBinding = sameConfiguration.filter((analysis) => (
      analysis.binding.key === cycleAnalysis?.binding.key
    ));
    const progressAnalysis = newestAnalysis(sameBinding.filter((analysis) => (
      analysis.kind === 'uploadProgress'
      && analysis.record.document?.benchmarkRunId === cycleRecord?.document?.runId
      && canonicalProjectName(analysis.record.document?.project)
        === canonicalProjectName(cycleRecord?.document?.project)
    )));
    const gateAnalysis = newestAnalysis(sameBinding.filter((analysis) => (
      analysis.kind === 'artifactGate'
      && analysis.workspaceIdentity?.key === cycleAnalysis?.workspaceIdentity?.key
    )));
    const progressRecord = progressAnalysis?.record || null;
    const gateRecord = gateAnalysis?.record || null;
    const cycleSource = evidenceReference(cycleRecord, now, maxAgeHours);
    const progressSource = evidenceReference(progressRecord, now, maxAgeHours);
    const gateSource = evidenceReference(gateRecord, now, maxAgeHours);
    const cycles = cycleRecord?.document?.cycles || {};
    const coldSkip = skippedEntry(cycleRecord?.document, 'cold');
    const exactSkip = skippedEntry(cycleRecord?.document, 'exact');
    const hotSkip = skippedEntry(cycleRecord?.document, 'hotEdit');
    const uploadSkip = skippedEntry(cycleRecord?.document, 'upload');
    const coldStage = coldSkip
        ? stageResult('skipped', coldSkip, cycleSource)
        : evaluateCompileCycle('cold', cycles.cold, cycleSource);
    coldStage.details = {
      ...(coldStage.details || {}),
      cacheReset: extractColdCacheReset(cycleRecord?.document, cycles.cold),
    };
    const stages = {
      cold: coldStage,
      exact: exactSkip
        ? stageResult('skipped', exactSkip, cycleSource)
        : evaluateCompileCycle('exact', cycles.exact, cycleSource),
      hotEdit: hotSkip
        ? stageResult('skipped', hotSkip, cycleSource)
        : evaluateCompileCycle('hotEdit', cycles.hotEdit, cycleSource),
      upload: uploadSkip
        ? stageResult('skipped', uploadSkip, cycleSource)
        : evaluateUpload(
          cycles.upload,
          progressRecord?.document?.uploadProgress || progressRecord?.document,
          cycleSource,
          progressSource,
        ),
      artifactGate: evaluateArtifactGate(gateRecord?.document, gateSource),
    };
    if (stages.cold.status === 'passed' && stages.hotEdit.status === 'passed') {
      const coldSeconds = stages.cold.details.seconds;
      const hotSeconds = stages.hotEdit.details.seconds;
      if (coldSeconds > 0 && hotSeconds !== null) {
        stages.hotEdit.details.improvementPercent = Number(((coldSeconds - hotSeconds) / coldSeconds * 100).toFixed(1));
      }
    }
    const selectedPaths = new Set([cycleRecord, progressRecord, gateRecord]
      .filter(Boolean)
      .map((record) => record.relativePath));
    const ignoredConfigurationEvidence = targetAnalyses
      .filter((analysis) => !selectedPaths.has(analysis.record.relativePath))
      .map((analysis) => ({
        path: analysis.record.relativePath,
        fqbn: analysis.record.document?.fqbn || null,
        reason: analysis.parsedFqbn.canonical !== canonicalFqbn
          ? 'different full FQBN; not merged into this row'
          : analysis.binding.key !== cycleAnalysis?.binding.key
            ? 'different source/gate/executable/process binding; not merged into this row'
            : analysis.kind === 'artifactGate'
                && analysis.workspaceIdentity?.key !== cycleAnalysis?.workspaceIdentity?.key
              ? 'different project/source/include identity; not merged into this row'
            : analysis.kind === 'uploadProgress'
                && (analysis.record.document?.benchmarkRunId !== cycleRecord?.document?.runId
                  || canonicalProjectName(analysis.record.document?.project)
                    !== canonicalProjectName(cycleRecord?.document?.project))
              ? 'different benchmark runId or project; not merged into this row'
              : 'older same-role evidence was not selected',
      }));
    const ignoredLegacyEvidence = records
      .filter((record) => (
        !documentKind(record.document)
        && looksLikeLegacyRegressionEvidence(record.document)
        && targetIdFromFqbn(record.document?.fqbn) === target.id
      ))
      .map((record) => ({
        path: record.relativePath,
        fqbn: record.document?.fqbn || null,
        reason: 'legacy or unrecognized schema has no trusted native evidence identity',
      }));
    return {
      id: target.id,
      label: target.label,
      fqbn,
      canonicalFqbn: fqbn ? canonicalFqbn : null,
      status: computeBoardStatus(stages),
      stages,
      evidence: {
        cycleReport: cycleSource,
        uploadReport: progressSource,
        artifactGateReport: gateSource,
        ignoredConfigurationEvidence,
        ignoredLegacyEvidence,
      },
    };
  });
  const counts = { passed: 0, failed: 0, skipped: 0, missing: 0 };
  for (const board of boards) {
    for (const stage of Object.values(board.stages)) counts[stage.status] += 1;
  }
  const overallStatus = counts.failed > 0 || combinedSourceErrors.length > 0
    ? 'failed'
    : counts.missing > 0 || counts.skipped > 0
      ? 'incomplete'
      : 'complete';
  return {
    schemaVersion: 1,
    schemaId: SUMMARY_SCHEMA_ID,
    generatedAt: now.toISOString(),
    generationMode: 'evidence-only',
    currentRunExecuted: false,
    notice: 'This summary only aggregates captured evidence. It does not compile, upload, open a serial port, or prove a current-session hardware result.',
    maxEvidenceAgeHours: maxAgeHours,
    strictFreshness,
    overallStatus,
    counts,
    targets: boards,
    sourceErrors: combinedSourceErrors,
  };
}

async function walkJsonFiles(directory) {
  const files = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(fullPath);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) files.push(fullPath);
    }
  }
  await visit(directory);
  return files.sort((left, right) => left.localeCompare(right, 'en'));
}

export async function scanEvidenceDirectory(directory) {
  const records = [];
  const errors = [];
  const root = path.resolve(directory);
  let files;
  try {
    files = await walkJsonFiles(root);
  } catch (error) {
    return { records, errors: [{ path: '.', error: String(error?.message || error) }] };
  }
  for (const filePath of files) {
    const relativePath = path.relative(root, filePath).split(path.sep).join('/');
    try {
      const document = JSON.parse(await readFile(filePath, 'utf8'));
      if (document?.schemaId === SUMMARY_SCHEMA_ID) continue;
      records.push({ relativePath, absolutePath: filePath, document });
    } catch (error) {
      errors.push({ path: relativePath, error: String(error?.message || error) });
    }
  }
  return { records, errors };
}

function markdownEscape(value) {
  return String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function formatSeconds(value) {
  return Number.isFinite(value) ? `${Number(value).toFixed(value >= 10 ? 1 : 2)}s` : '';
}

function markdownCell(stage) {
  if (stage.status === 'passed') {
    const seconds = formatSeconds(stage.details?.seconds);
    return `✅ 通过*${seconds ? ` · ${seconds}` : ''}`;
  }
  if (stage.status === 'failed') return '❌ 失败';
  if (stage.status === 'skipped') return '⏭ 跳过';
  return '— 缺失';
}

export function renderMarkdown(summary) {
  const lines = [
    '# CK 编译回归摘要',
    '',
    `生成时间：${summary.generatedAt}`,
    '',
    '> 证据汇总模式：本命令没有执行编译、上传、串口或真机操作。“通过”只表示对应来源文件记录的历史测试通过，不代表本轮刚刚实测。',
    '',
    '| 目标 | 完整 FQBN | 冷编译 | Exact | 热编辑 | 上传 | 产物门禁 |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const board of summary.targets) {
    lines.push(`| ${markdownEscape(board.label)} | ${markdownEscape(board.fqbn || '未发现证据')} | ${markdownCell(board.stages.cold)} | ${markdownCell(board.stages.exact)} | ${markdownCell(board.stages.hotEdit)} | ${markdownCell(board.stages.upload)} | ${markdownCell(board.stages.artifactGate)} |`);
  }
  lines.push('', '* “通过*”均为带捕获时间与来源路径的导入证据，不是本轮新测试。');
  lines.push('', `汇总状态：**${summary.overallStatus}**；通过 ${summary.counts.passed}，失败 ${summary.counts.failed}，跳过 ${summary.counts.skipped}，缺失 ${summary.counts.missing}。`);
  lines.push('', '## 证据来源');
  lines.push('');
  for (const board of summary.targets) {
    lines.push(`### ${board.label}`);
    lines.push('');
    const cacheReset = board.stages.cold.details?.cacheReset;
    if (!board.fqbn) {
      lines.push('- 没有发现该目标的结构化证据。');
      lines.push(`- 冷编译缓存口径：scope=${cacheReset?.scope || 'unknown'}；ccache store=${cacheReset?.ccacheStore || 'unknown'}；prebuilt core=${cacheReset?.prebuiltCore || 'unknown'}；force recache=${cacheReset?.forceCcacheRecache || 'unknown'}；force rebuild pending=${cacheReset?.forceRebuildPending ?? 'unknown'}`);
      lines.push('');
      continue;
    }
    lines.push(`- FQBN：\`${board.fqbn}\``);
    lines.push(`- 冷编译缓存口径：scope=${cacheReset?.scope || 'unknown'}；ccache store=${cacheReset?.ccacheStore || 'unknown'}；prebuilt core=${cacheReset?.prebuiltCore || 'unknown'}；force recache=${cacheReset?.forceCcacheRecache || 'unknown'}；force rebuild pending=${cacheReset?.forceRebuildPending ?? 'unknown'}`);
    for (const [label, reference] of [
      ['编译会话', board.evidence.cycleReport],
      ['上传报告', board.evidence.uploadReport],
      ['产物门禁', board.evidence.artifactGateReport],
    ]) {
      if (reference) lines.push(`- ${label}：\`${reference.path}\`，捕获于 ${reference.capturedAt || '未知'}，新鲜度 ${reference.freshness}`);
    }
    for (const [stageName, stage] of Object.entries(board.stages)) {
      if (stage.status !== 'passed') {
        lines.push(`- ${stageName}：${STATUS_LABELS[stage.status]}；${stage.details?.reason || '没有更多说明'}`);
      }
    }
    lines.push('');
  }
  if (summary.sourceErrors.length) {
    lines.push('## 无法读取的证据');
    lines.push('');
    for (const error of summary.sourceErrors) lines.push(`- \`${error.path}\`：${error.error}`);
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

export function renderConsole(summary) {
  const headers = ['目标', '冷编译', 'Exact', '热编辑', '上传', '产物门禁'];
  const rows = summary.targets.map((board) => [
    board.label,
    ...STAGES.map((stage) => {
      const result = board.stages[stage];
      const seconds = formatSeconds(result.details?.seconds);
      return `${STATUS_LABELS[result.status]}${seconds ? ` ${seconds}` : ''}`;
    }),
  ]);
  const widths = headers.map((header, index) => Math.max(
    header.length,
    ...rows.map((row) => row[index].length),
  ));
  const formatRow = (row) => row.map((cell, index) => cell.padEnd(widths[index])).join(' | ');
  return [
    'CK 编译回归摘要（仅汇总证据；本命令未运行编译/上传/串口）',
    formatRow(headers),
    widths.map((width) => '-'.repeat(width)).join('-|-'),
    ...rows.map(formatRow),
    `状态=${summary.overallStatus} 通过=${summary.counts.passed} 失败=${summary.counts.failed} 跳过=${summary.counts.skipped} 缺失=${summary.counts.missing}`,
  ].join('\n');
}

function parseArguments(argv, root) {
  const options = {
    evidenceDirectory: path.join(root, 'artifacts', 'benchmarks'),
    jsonOutputPath: path.join(root, 'artifacts', 'benchmarks', 'compile-regression-summary.json'),
    markdownOutputPath: path.join(root, 'artifacts', 'benchmarks', 'compile-regression-summary.md'),
    maxAgeHours: 168,
    now: new Date(),
    write: true,
    strict: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const takeValue = () => {
      if (index + 1 >= argv.length) throw new Error(`${argument} requires a value`);
      index += 1;
      return argv[index];
    };
    if (argument === '--evidence-dir') options.evidenceDirectory = path.resolve(takeValue());
    else if (argument === '--json') options.jsonOutputPath = path.resolve(takeValue());
    else if (argument === '--markdown') options.markdownOutputPath = path.resolve(takeValue());
    else if (argument === '--max-age-hours') options.maxAgeHours = Number(takeValue());
    else if (argument === '--now') options.now = new Date(takeValue());
    else if (argument === '--no-write') options.write = false;
    else if (argument === '--strict') options.strict = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!Number.isFinite(options.maxAgeHours) || options.maxAgeHours < 0) throw new Error('--max-age-hours must be a non-negative number');
  if (!Number.isFinite(options.now.getTime())) throw new Error('--now must be a valid date');
  return options;
}

export async function runCli(argv = process.argv.slice(2)) {
  const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(scriptDirectory, '..');
  const options = parseArguments(argv, root);
  if (options.help) {
    console.log('Usage: node scripts/Summarize-CompileRegression.mjs [--evidence-dir DIR] [--json FILE] [--markdown FILE] [--max-age-hours N] [--no-write] [--strict]');
    return 0;
  }
  const scanned = await scanEvidenceDirectory(options.evidenceDirectory);
  const summary = buildSummary(scanned.records, {
    now: options.now,
    maxAgeHours: options.maxAgeHours,
    sourceErrors: scanned.errors,
    strictFreshness: options.strict,
  });
  const markdown = renderMarkdown(summary);
  if (options.write) {
    await mkdir(path.dirname(options.jsonOutputPath), { recursive: true });
    await mkdir(path.dirname(options.markdownOutputPath), { recursive: true });
    await writeFile(options.jsonOutputPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    await writeFile(options.markdownOutputPath, markdown, 'utf8');
  }
  console.log(renderConsole(summary));
  if (options.write) {
    console.log(`JSON: ${options.jsonOutputPath}`);
    console.log(`Markdown: ${options.markdownOutputPath}`);
  }
  return options.strict && summary.overallStatus !== 'complete' ? 2 : 0;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runCli().then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((error) => {
    console.error(error?.stack || String(error));
    process.exitCode = 1;
  });
}
