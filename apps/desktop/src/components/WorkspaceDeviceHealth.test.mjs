import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./Workspace.tsx', import.meta.url), 'utf8');
const healthViewSource = await readFile(new URL('./EngineeringHealthView.tsx', import.meta.url), 'utf8');
const releaseNotesSource = await readFile(new URL('../data/release_notes.ts', import.meta.url), 'utf8');
const c6RegressionPlanSource = await readFile(
    new URL('../../../../docs/esp32-c6-hardware-regression-plan.md', import.meta.url),
    'utf8',
);
const handlerStart = source.indexOf('const handleInspectDevice = async () =>');
const handlerEnd = source.indexOf('const handleSendSerial = async () =>', handlerStart);
const handler = source.slice(handlerStart, handlerEnd);

test('wires a labeled wide action and a labeled narrow-window menu action', () => {
    assert.match(source, /data-ck-role="device-health-button"/);
    assert.match(source, /data-ck-role="device-health-menu-action"/);
    assert.match(source, />真机体检<\/span>/);
    assert.match(source, /短暂复位，不写 Flash/);
    assert.match(source, /min-\[1500px\]:inline-flex/);
});

test('locks both run-trace entry points while device inspection owns the serial workflow', () => {
    assert.match(
        source,
        /onClick=\{\(\) => void handleStartBlockTrace\(\)\}[\s\S]{0,180}disabled=\{isCompiling \|\| isDeviceHealthRunning \|\| blockDebugSession\.active\}/,
    );
    assert.match(
        source,
        /onClick=\{\(\) => \{ void handleStartBlockTrace\(\); setIsViewMenuOpen\(false\); \}\}[\s\S]{0,180}disabled=\{isCompiling \|\| isDeviceHealthRunning \|\| blockDebugSession\.active\}/,
    );
});

test('invokes the structured backend request only after ESP32 and port gates', () => {
    assert.ok(handlerStart >= 0 && handlerEnd > handlerStart);
    assert.match(handler, /if \(!activePort\)/);
    assert.match(handler, /if \(!isEsp32DeviceHealthTarget\(effectiveCompileFqbn\)\)/);
    assert.match(handler, /invoke<unknown>\('inspect_device', \{/);
    assert.match(handler, /requestId: target\.requestId/);
    assert.match(handler, /fqbn: target\.fqbn/);
    assert.match(handler, /port: target\.port/);
});

test('gates publication by request id, active port, and effective FQBN', () => {
    assert.match(handler, /isSameDeviceHealthTarget\(target, \{/);
    assert.match(handler, /requestId: deviceHealthRequestIdRef\.current/);
    assert.match(handler, /fqbn: effectiveCompileFqbnRef\.current/);
    assert.match(handler, /port: activePortRef\.current \|\| ''/);
    assert.match(handler, /report\.requestId !== target\.requestId/);
    assert.match(handler, /setDeviceHealthPublication\(\{ target, report \}\)/);
    assert.match(handler, /const requestStillLatest = deviceHealthRequestIdRef\.current === requestId/);
    assert.match(handler, /else if \(requestStillLatest\) \{[\s\S]*?previous\.type === 'loading'[\s\S]*?show: false/);
});

test('synchronously releases and restores the existing serial monitor', () => {
    const closeIndex = handler.indexOf("await invoke('close_serial_monitor')");
    const inspectIndex = handler.indexOf("invoke<unknown>('inspect_device'");
    const restoreIndex = handler.indexOf('await openSerialMonitorWithSettings(');
    assert.ok(closeIndex >= 0 && closeIndex < inspectIndex, 'monitor must be released before the probe');
    assert.ok(restoreIndex > inspectIndex, 'monitor restoration must happen after the probe');
    assert.match(handler, /\[0, 150, 200, 350, 500\]/);
    assert.match(handler, /serialSettingsSeqRef\.current === serialOperationSeq/);
});

test('keeps health results separate from compile resource snapshots', () => {
    assert.doesNotMatch(handler, /saveCompileResourceSnapshot/);
    assert.doesNotMatch(handler, /setCompileResourceReport/);
    assert.doesNotMatch(handler, /setCompileResourceSnapshot/);
});

test('places the result between compile doctor and resource budget in the independent engineering health dock', () => {
    const doctorIndex = healthViewSource.indexOf('<CompileDoctorPanel');
    const healthIndex = healthViewSource.indexOf('<DeviceHealthPanel');
    const resourcesIndex = healthViewSource.indexOf('<ResourceBudgetPanel');
    assert.ok(doctorIndex >= 0 && doctorIndex < healthIndex);
    assert.ok(healthIndex < resourcesIndex);
    assert.match(source, /deviceHealthReport=\{currentDeviceHealthReport\}/);
    assert.match(source, /isDeviceHealthRunning=\{isDeviceHealthRunning\}/);
    assert.match(source, /openEngineeringHealth\(\)/);
    assert.doesNotMatch(source, /setConsoleTab\('health'\)/);
});

test('states the reset/no-write boundary before starting the request', () => {
    assert.match(handler, /开发板会短暂复位，但不会写入 Flash/);
    assert.match(source, /会短暂复位开发板，但不会擦除或写入 Flash/);
});

test('release notes state the supported entry points, no-write boundary, and verification scope', () => {
    assert.match(releaseNotesSource, /端口菜单或宽屏顶栏启动“真机体检”/);
    assert.match(releaseNotesSource, /“真机体检”会短暂复位 ESP32，但不会编译、擦除或写入 Flash/);
    assert.match(releaseNotesSource, /ESP32 为系列支持；目前登记真板证据的具体型号是 ESP32-S3、ESP32-C3、ESP32-C5 N16R8，以及 ESP32-C6 N16/);
    assert.match(releaseNotesSource, /ESP32 Core 3\.3\.6 真板体检、冷\/热编译、产物门禁与多段上传通过/);
    assert.match(releaseNotesSource, /16 MiB Flash、8 MiB PSRAM 运行时实测/);
    assert.match(releaseNotesSource, /均按各自 Core、完整 FQBN 与实体配置记录/);
    assert.match(releaseNotesSource, /其他 ESP32 子型号或配置不能据此视为已完成真板验证/);
});

test('release notes and the C6 runbook never promote an unbound historical timing as the current candidate', () => {
    assert.doesNotMatch(releaseNotesSource, /98\.24、104\.42、98\.39/);
    assert.doesNotMatch(releaseNotesSource, /相对用户最初 317\.7 秒日志缩短 69\.0%/);
    assert.match(releaseNotesSource, /当前候选绑定的 3\+3 严格摘要/);
    assert.match(releaseNotesSource, /历史会话只用于诊断，不能冒充当前候选/);

    assert.match(c6RegressionPlanSource, /本文件定义当前候选的可重复真板验收规范/);
    assert.match(c6RegressionPlanSource, /旧目录中的报告即使写着 `passed`/);
    assert.match(c6RegressionPlanSource, /ready-install 相对 first-project 的 median 和 nearest-rank p95 都必须缩短至少 30%/);
    assert.doesNotMatch(c6RegressionPlanSource, /状态：已完成最终 production EXE/);
});
