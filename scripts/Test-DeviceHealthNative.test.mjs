import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./Test-DeviceHealthNative.ps1', import.meta.url), 'utf8');
const bindingSource = await readFile(new URL('./NativeEvidenceBinding.psm1', import.meta.url), 'utf8');
const workspaceSource = await readFile(new URL('../apps/desktop/src/components/Workspace.tsx', import.meta.url), 'utf8');
const nodeMatch = source.match(/\$nodeScript\s*=\s*@'\r?\n([\s\S]*?)\r?\n'@/);
assert.ok(nodeMatch, 'embedded Node here-string should be present');
const embeddedNode = nodeMatch[1];

test('embedded CDP program is valid JavaScript', () => {
    assert.doesNotThrow(() => new Function(embeddedNode));
});

test('streams the embedded program over stdin without putting it on the Windows command line', () => {
    assert.match(source, /\$nodeScript\s*\|\s*node\s+-/);
    assert.doesNotMatch(source, /(?:^|\s)node(?:\.exe)?\s+-e\b/im);
    assert.doesNotMatch(source, /WriteAllText\([^\r\n]*\$nodeScript/);
    assert.equal((source.match(/\$nodeScript\s*\|\s*node\s+-/g) || []).length, 1);
});

test('targets the main CK page without touching the detached console', () => {
    assert.match(bindingSource, /console=detached/);
    assert.match(source, /CK_DEVICE_HEALTH_PORT/);
    assert.match(source, /CK_DEVICE_HEALTH_PROJECT/);
    assert.match(source, /CK_DEVICE_HEALTH_FQBN/);
    assert.match(source, /\[switch\]\$VerifySerialRestore/);
    assert.match(source, /CK_DEVICE_HEALTH_VERIFY_SERIAL_RESTORE/);
});

test('requires the exact c3 project and exact resolved FQBN before any probe', () => {
    assert.match(workspaceSource, /data-ck-role="workspace-project-identity"/);
    assert.match(workspaceSource, /data-ck-project-name=/);
    assert.match(embeddedNode, /workspace-project-identity/);
    assert.match(embeddedNode, /Refusing to inspect the wrong open project/);
    assert.match(embeddedNode, /if \(actualFqbn === expectedFqbn\) return actualFqbn/);
    assert.match(embeddedNode, /Board mismatch after waiting for project configuration/);
    assert.match(embeddedNode, /\['resolved', 'core-default'\]/);
});

test('selects the requested serial port by exact text equality', () => {
    assert.match(embeddedNode, /serial refresh and selector controls/);
    assert.match(embeddedNode, /list_serial_ports/);
    assert.match(embeddedNode, /discovery after refresh/);
    assert.match(embeddedNode, /button\.title === \$\{JSON\.stringify\(port\)\}/);
    assert.match(embeddedNode, /textContent\?\.trim\(\) === \$\{JSON\.stringify\(port\)\}/);
    assert.doesNotMatch(embeddedNode, /textContent\.includes\(\$\{JSON\.stringify\(port\)\}\)/);
});

test('optionally opens the serial monitor and verifies restoration after inspection', () => {
    assert.match(embeddedNode, /async function ensureSerialMonitorOpen\(\)/);
    assert.match(embeddedNode, /async function verifySerialMonitorRestored\(\)/);
    assert.match(embeddedNode, /serial monitor restoration after device health/);
    assert.match(embeddedNode, /verifySerialRestore\s*\? await verifySerialMonitorRestored\(\)/);
    assert.match(embeddedNode, /serialRestore:\s*\{/);
});

test('clicks only a labeled device-health action and waits for a real active transition', () => {
    assert.match(embeddedNode, /device-health-button/);
    assert.match(embeddedNode, /device-health-menu-action/);
    assert.ok(embeddedNode.includes(String.raw`label.includes('\u771f\u673a\u4f53\u68c0')`));
    assert.match(embeddedNode, /seenActive/);
    assert.match(embeddedNode, /completed device-health result/);
    assert.equal(
        [...embeddedNode.matchAll(/textContent\.replace\(\/\\\\s\+\/g/g)].length,
        5,
        'whitespace regexes inside Runtime.evaluate templates must retain their backslash',
    );
});

test('requires full MAC in the local panel while keeping logs and exported evidence redacted', () => {
    assert.match(embeddedNode, /\['healthy', 'attention'\]\.includes\(result\.status\)/);
    assert.match(embeddedNode, /fullMacPatterns/);
    assert.match(embeddedNode, /!containsFullMac\(result\.panelText\)/);
    assert.match(embeddedNode, /containsFullMac\(result\.outputText\)/);
    assert.match(embeddedNode, /!containsFullMac\(result\.pageText\)/);
    assert.match(embeddedNode, /exportedPanelTextRedacted:\s*true/);
    assert.match(embeddedNode, /REDACTED_MAC/);
});

test('emits only a bounded, redacted summary', () => {
    assert.match(embeddedNode, /redactAndBound\(result\.panelText\)/);
    assert.match(embeddedNode, /CK_DEVICE_HEALTH_RESULT=/);
    assert.doesNotMatch(embeddedNode, /panelText:\s*result\.panelText/);
    assert.doesNotMatch(embeddedNode, /outputText:\s*result\.outputText/);
    assert.doesNotMatch(embeddedNode, /pageText:\s*result\.pageText/);
});

test('publishes structured chip, physical Flash, FQBN, privacy, and serial-restore checks', () => {
    for (const id of [
        'chip-family-confirmed',
        'physical-flash-confirmed',
        'full-fqbn-visible',
        'local-mac-output-redacted',
        'serial-monitor-restored',
    ]) {
        assert.match(embeddedNode, new RegExp(id));
    }
    assert.match(embeddedNode, /ckDeviceChipModel/);
    assert.match(embeddedNode, /ckDeviceFlashBytes/);
    assert.match(embeddedNode, /ckDeviceConfiguredFlashBytes/);
    assert.match(embeddedNode, /ckDevicePsramBytes/);
    assert.match(embeddedNode, /ckDevicePsramCheckState/);
    assert.match(embeddedNode, /ckDeviceFqbn/);
    assert.match(embeddedNode, /hardwareEvidence:\s*\{/);
    assert.match(embeddedNode, /configuredFlashBytes,/);
    assert.match(embeddedNode, /psramBytes,/);
    assert.match(embeddedNode, /psramEvidenceState:\s*psramBytes == null \? 'unknown' : 'reported'/);
    assert.match(embeddedNode, /psramCheckState,/);
    assert.match(embeddedNode, /function parseOptionalPositiveCapacity\(value, label\)/);
    assert.match(embeddedNode, /if \(!text\) return null/);
    assert.doesNotMatch(embeddedNode, /Number\(panel\?\.dataset\.ckDevicePsramBytes \|\| 0\)/);
});

test('publishes top-level failures and exits nonzero when any structured health check fails', () => {
    assert.match(embeddedNode, /const failures = structuredChecks/);
    assert.match(embeddedNode, /\.filter\(\(check\) => check\.passed !== true\)/);
    assert.match(embeddedNode, /checks:\s*structuredChecks,\s*\n\s*failures,/);
    assert.match(embeddedNode, /if \(failures\.length > 0\)/);
    assert.match(embeddedNode, /Device-health outcome checks failed/);
});
