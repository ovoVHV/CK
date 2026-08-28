import crypto from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const qualificationRoot = join(root, 'apps', 'desktop', 'src-tauri', 'state', 'qualifications');
const output = join(
  root,
  'apps',
  'desktop',
  'src-tauri',
  'src',
  'ck_forge_bundled_qualifications.v1.json',
);

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const sha256Pattern = /^[0-9a-f]{64}$/u;
const nativeRelinkCertificateKeys = [
  'candidateProfile', 'evidenceSha256', 'reportSha256', 'schemaId', 'schemaVersion',
];
const nativeRelinkCertificateHasExactShape = (certificate) => certificate !== null
  && typeof certificate === 'object'
  && !Array.isArray(certificate)
  && JSON.stringify(Object.keys(certificate).sort())
    === JSON.stringify(nativeRelinkCertificateKeys)
  && certificate.schemaId === 'ck.forge.local-performance-certificate'
  && certificate.schemaVersion === 4
  && certificate.candidateProfile === 'native-relink-compile-only'
  && typeof certificate.evidenceSha256 === 'string'
  && sha256Pattern.test(certificate.evidenceSha256)
  && typeof certificate.reportSha256 === 'string'
  && sha256Pattern.test(certificate.reportSha256);
const entries = new Map();

for (const name of readdirSync(qualificationRoot).sort()) {
  if (!/^[0-9a-f]{64}$/u.test(name)) continue;
  const directory = join(qualificationRoot, name);
  const certificate = JSON.parse(readFileSync(join(directory, 'certificate.json'), 'utf8'));
  const evidenceBytes = readFileSync(join(directory, 'evidence.json'));
  const reportBytes = readFileSync(join(directory, 'report.json'));
  const report = JSON.parse(reportBytes.toString('utf8'));
  if (!nativeRelinkCertificateHasExactShape(certificate)
      || certificate.evidenceSha256 !== sha256(evidenceBytes)
      || certificate.reportSha256 !== sha256(reportBytes)
      || report.schemaId !== 'ck.forge.native-relink-local-qualification-report'
      || report.schemaVersion !== 1
      || report.qualificationKey !== name
      || report.status !== 'qualified-native-relink'
      || report.qualified !== true
      || report.candidateProfile !== certificate.candidateProfile
      || !report.target?.fqbn
      || !report.target?.coreVersion) {
    throw new Error(`bundled FLFE qualification failed catalog validation: ${name}`);
  }
  const entry = {
    fqbn: report.target.fqbn,
    coreVersion: report.target.coreVersion,
  };
  entries.set(`${entry.fqbn}\0${entry.coreVersion}`, entry);
}

if (entries.size === 0) throw new Error('bundled FLFE qualification catalog cannot be empty');
const document = {
  schemaId: 'ck.forge.bundled-qualification-catalog',
  schemaVersion: 1,
  candidateProfile: 'native-relink-compile-only',
  entries: [...entries.values()].sort((left, right) => (
    left.fqbn.localeCompare(right.fqbn) || left.coreVersion.localeCompare(right.coreVersion)
  )),
};
const next = `${JSON.stringify(document)}\n`;
let current = null;
try {
  current = readFileSync(output, 'utf8');
} catch {
  // The first generation creates the file below.
}
if (current !== next) writeFileSync(output, next, 'utf8');
process.stdout.write(`CK Forge bundled qualification catalog: ${document.entries.length} exact Core/FQBN identities\n`);
