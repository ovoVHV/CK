import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./LibraryManagerModal.tsx', import.meta.url), 'utf8');

test('ordinary Arduino ZIP imports retain backend quality evidence after refresh', () => {
    assert.match(source, /invoke\('install_arduino_library_zip', \{ path: item\.path \}\)/);
    assert.match(source, /qualityReport: item\?\.library\?\.ck_quality_report/);
    assert.match(source, /installSource: item\?\.library\?\.ck_install_source/);
});

test('installed Arduino ZIP rows expose status and the machine-readable report', () => {
    assert.match(source, /PackageQualityStatusBadge report=\{lib\.qualityReport\}/);
    assert.match(source, /t\('manager\.quality\.view'\)/);
    assert.match(source, /PackageQualityReportPanel/);
    assert.match(source, /source === 'local-arduino-zip'/);
});
