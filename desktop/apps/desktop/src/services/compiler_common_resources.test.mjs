import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { loadResourceModule } from './resource_test_loader.mjs';

const { observeCompilerResources } = await loadResourceModule('./compiler_resource_observation.ts');
const { interruptLatencyFindings, currentCompilerResourcePresentation, currentCompilerObservationStatus, markCompilerObservationStale } = await loadResourceModule('./compiler_resource_integration.ts');
const { buildHardwareResourceInspector } = await loadResourceModule('./hardware_resource_inspector.ts');
const { verifiedCompilerApis } = await loadResourceModule('./compiler_api_evidence.ts');
const { sha256Hex: hash, wrapCompileSourceBoundary, freezeCompileSourceMap } = await loadResourceModule('./compile_source_map.ts');
const context = { fqbn: 'thirdparty:arch:board', mcu: 'test', variant: 'test', coreVersion: 'test', fCpu: '1L', options: {} };
const sketch = '/test/sketch.ino', api = '/test/implementation.cpp', header = '/test/implementation.h';
function fixture(calls, entries, sameBlock = false) {
    const code = `void setup() {\n${calls.map((call, i) => wrapCompileSourceBoundary(call, {
        blockId: sameBlock ? 'same-block' : `block-${i}`, blockType: 'unmodified_external_block', boundaryId: `b${i}`, section: 'setup', confidence: 'high',
    })).join('\n')}\n}`;
    const gimple = `void setup() ()\n{\n${calls.map((call, i) => `[${sketch}:${i + 2}:1] ${call}`).join('\n')}\n}`;
    const sources = [sketch, api, header].map(path => ({ path, sha256: hash(path) }));
    const graph = { version: 1, coverage: 'full', routes: [],
        evidence: [{ id: 'source', source: 'test-only', confidence: 'declared' }],
        resources: [
            { id: 'gpio.8', aliases: ['8'], type: 'gpio', sharing: 'exclusive', evidence: ['source'] },
            { id: 'gpio.9', aliases: ['9'], type: 'gpio', sharing: 'exclusive', evidence: ['source'] },
            { id: 'timer-x', aliases: ['TIMER1'], type: 'timer', sharing: 'shared', evidence: ['source'] },
            { id: 'pwm-x', type: 'pwm-channel', parent: 'timer-x', sharing: 'shared', evidence: ['source'] },
            { id: 'uart-x', aliases: ['Serial'], type: 'uart-controller', sharing: 'configuration', configurationKeys: ['baud'], evidence: ['source'] },
        ],
    };
    const symbols = entries.map(entry => `${entry.callee}(int)`);
    return {
        graph, sourceMap: freezeCompileSourceMap(code, { file: sketch }), apiEvidence: [],
        mappings: { pwm: { 9: 'pwm-x' } },
        primitiveEvidence: entries.map(entry => ({ definitionFile: api, headerFile: header, context,
            sourceEvidence: sources.filter(source => source.path !== sketch), definedSymbols: symbols, ...entry })),
        current: { context, code, sources, compileCommandsSha256: hash('command') },
        snapshot: { context, sources, codeSha256: hash(code), compileCommandsSha256: hash('command'),
            graphSha256: hash(JSON.stringify(graph)), compiledFiles: [sketch, api],
            units: [{ file: sketch, kind: 'sketch', gimple, gimpleSha256: hash(gimple), commandSha256: hash('command'),
                dependencies: [header], definedSymbols: ['setup'], referencedSymbols: symbols }],
        },
    };
}
const servo = { callee: 'Driver::attach', kind: 'servo-attach', receiverArgument: 0, valueArgument: 1, timer: 'TIMER1' };
const pwm = { callee: 'analogWrite', kind: 'pwm' };
const mask = { callee: 'Transport::begin', kind: 'interrupt-blocking', receiverArgument: 0 };

test('independent names and a third-party graph: timer conflict comes from existing analyzer', () => {
    const input = fixture(['Driver::attach (&actuator, 8);', 'analogWrite (9, 100);'], [servo, pwm]);
    const before = structuredClone(input), result = observeCompilerResources(input);
    assert.equal(result.status, 'Partial');
    assert.ok(result.analysis.conflicts.some(item => item.resource === 'timer-x' && item.code === 'exclusive-conflict'));
    assert.deepEqual(input, before);
    assert.equal(result.traces[0].blockId, 'block-0', 'high-confidence setup mapping uses existing block identity');
});

test('interrupt blocking + timing sensitivity is a warning finding, never a fabricated Timer claim', () => {
    const result = observeCompilerResources(fixture(['Driver::attach (&actuator, 8);', 'Transport::begin (&link, 9600);'], [servo, mask]));
    assert.equal(result.analysis.conflicts.length, 0);
    assert.equal(result.claims.some(claim => claim.reference === 'block-1'), false);
    assert.equal(interruptLatencyFindings(result.timing).length, 1);
    assert.equal(interruptLatencyFindings(result.timing.filter(item => item.effect === 'interrupt-blocking')).length, 0);
});

test('unresolved multi-timer allocation keeps signal and timing risk but invents no Timer', () => {
    const result = observeCompilerResources(fixture(['Driver::attach (&actuator, 8);'], [{ ...servo, timer: undefined }]));
    assert.equal(result.claims.length, 1);
    assert.equal(result.claims[0].role, 'servo-signal');
    assert.ok(result.gaps.includes('recognition.timer-allocation.unresolved'));
});

test('no PWM map, dynamic duty, or dynamic GPIO produces guessed bindings', () => {
    for (const call of ['analogWrite (8, 100);', 'analogWrite (9, runtimeDuty);', 'analogWrite (runtimePin, 100);']) {
        const result = observeCompilerResources(fixture([call], [pwm]));
        assert.equal(result.claims.length, 0, call);
    }
});
test('PWM 0 and 255 are digital output, not Timer consumers', () => {
    for (const value of [0, 255]) {
        const result = observeCompilerResources(fixture([`analogWrite (9, ${value});`], [pwm]));
        assert.equal(result.claims.length, 1);
        assert.equal(result.claims[0].resource, 'gpio.9');
        assert.equal(result.claims[0].role, 'digital-output');
    }
});
test('generated PWM setup does not create a second consumer conflicting with its own output', () => {
    const input = fixture(['pinMode (9, 1);', 'analogWrite (9, 100);'],
        [{ callee: 'pinMode', kind: 'pin-mode' }, pwm], true);
    input.graph.routes.push({ id: 'output', resource: 'pwm-x', signal: 'output', mode: 'fixed', pins: ['gpio.9'] });
    input.snapshot.graphSha256 = hash(JSON.stringify(input.graph));
    const result = observeCompilerResources(input);
    assert.equal(result.claims.length, 1);
    assert.equal(result.claims[0].role, 'hardware-pwm');
    assert.equal(result.analysis.conflicts.length, 0);
});
test('UART receiver comes from the graph alias, never a board name', () => {
    const entry = { callee: 'Transport::begin', kind: 'uart', receiverArgument: 0, valueArgument: 1 };
    const result = observeCompilerResources(fixture(['Transport::begin (&Serial, 115200);'], [entry]));
    assert.equal(result.claims[0].resource, 'uart-x');
    assert.equal(result.claims[0].configuration.baud, 115200);
    assert.equal(observeCompilerResources(fixture(['Transport::begin (&UnknownPort, 115200);'], [entry])).claims.length, 0);
});
test('source change, missing source dependency, or wrong selected symbol disables primitive summaries', () => {
    for (const change of [
        input => { input.primitiveEvidence[0].sourceEvidence[0] = { path: api, sha256: hash('modified') }; },
        input => { input.snapshot.units[0].dependencies = []; },
        input => { input.snapshot.units[0].referencedSymbols = ['Other::attach(int)']; },
    ]) {
        const input = fixture(['Driver::attach (&actuator, 8);'], [servo]);
        change(input);
        assert.equal(observeCompilerResources(input).claims.length, 0);
    }
});
test('tampered preprocessor output is not evidence for timer selection', () => {
    const input = fixture(['Driver::attach (&actuator, 8);'], [servo]);
    input.snapshot.units[0].preprocessed = 'tampered';
    input.snapshot.units[0].preprocessedSha256 = hash('original');
    assert.ok(observeCompilerResources(input).gaps.includes('recognition.compiler-evidence.invalid'));
});
test('the source catalogue rejects familiar names without matching source bytes', () => {
    const value = verifiedCompilerApis({ ...fixture([], []).snapshot, symbols: [], gaps: [] });
    assert.deepEqual(value, { primitives: [], i2c: [] });
});
test('controller initialization is usage, not a fabricated bus device', () => {
    const input = fixture([], []);
    input.graph.resources.push({ id: 'spi-test', type: 'spi-controller', sharing: 'selector', evidence: ['source'] });
    const claim = { id: 'c1', reference: 'original-block', owner: 'controller', resource: 'spi-test', role: 'spi-controller-use' };
    const { analyzeHardwareResources } = graphModule;
    const view = buildHardwareResourceInspector({ graph: input.graph, claims: [claim], analysis: analyzeHardwareResources(input.graph, [claim], 1) });
    assert.equal(view.buses[0].devices.length, 0);
    assert.equal(view.buses[0].currentUsage.length, 1);
});
const graphModule = await loadResourceModule('./hardware_resource_graph.ts');
test('multiple calls in the same implementation pair share one warning with every original block locator', () => {
    const effect = (blockId, effect, implementation) => ({ blockId, effect, implementation, evidence: [], steps: [] });
    const findings = interruptLatencyFindings([
        effect('a', 'interrupt-sensitive', 'driver'),
        effect('b', 'interrupt-blocking', 'transport'),
        effect('c', 'interrupt-blocking', 'transport'),
    ]);
    assert.equal(findings.length, 1);
    assert.deepEqual([...findings[0].blockReferences].sort(), ['a', 'b', 'c']);
});
test('conditional primitives stay unresolved rather than asserting simultaneous ownership', () => {
    const input = fixture(['Driver::attach (&actuator, 8);'], [servo]);
    const unit = input.snapshot.units[0];
    unit.gimple = unit.gimple.replace('{', '{\nif (condition != 0) goto <D.1>; else goto <D.2>;\n<D.1>:').replace('}', '<D.2>:\n}');
    unit.gimpleSha256 = hash(unit.gimple);
    assert.equal(observeCompilerResources(input).claims.length, 0);
});
test('compiler presentation is never reused for changed workspace, code or target', () => {
    const cache = { workspaceJson: '{}', fqbn: 'x:y:z', codeSha256: hash('code'), evaluation: { report: { status: 'warning' } } };
    for (const [workspace, fqbn, code] of [['[]', 'x:y:z', 'code'], ['{}', 'other', 'code'], ['{}', 'x:y:z', 'new-code']]) {
        assert.equal(currentCompilerResourcePresentation(cache, workspace, fqbn, code), null);
    }
    const result = currentCompilerResourcePresentation(cache, '{}', 'x:y:z', 'code');
    result.report.status = 'pass';
    assert.equal(cache.evaluation.report.status, 'warning');
});
test('implementation lifecycle is explicit and independent of resource pass/conflict', () => {
    const attempt = { workspaceJson: '{}', fqbn: 'x:y:z', codeSha256: hash('code'), status: 'running' };
    assert.equal(currentCompilerObservationStatus(null, '{}', 'x:y:z', 'code'), 'needs-compile');
    for (const state of ['running', 'partial', 'unavailable']) {
        attempt.status = state;
        assert.equal(currentCompilerObservationStatus(attempt, '{}', 'x:y:z', 'code'), state);
    }
});
test('edits, board changes and code changes invalidate running as well as completed observations', () => {
    for (const status of ['running', 'partial', 'unavailable']) {
        const attempt = { workspaceJson: '{}', fqbn: 'x:y:z', codeSha256: hash('code'), status };
        const before = structuredClone(attempt);
        for (const [workspace, fqbn, code] of [['[]', 'x:y:z', 'code'], ['{}', 'other', 'code'], ['{}', 'x:y:z', 'new-code']]) {
            assert.equal(currentCompilerObservationStatus(attempt, workspace, fqbn, code), 'stale');
        }
        assert.deepEqual(attempt, before);
    }
});
test('stale observation remains visible even before a board model is available', () => {
    const input = { report: { status: 'unavailable', coverage: null, issues: [], checks: [] }, inspector: null, analysis: null };
    const result = markCompilerObservationStale(input);
    assert.equal(result.report.implementationCheck, 'stale');
    assert.equal(result.report.status, 'unavailable');
    assert.equal(input.report.implementationCheck, undefined);
});
test('stale compiler facts are explicitly a warning, not a cleared all-good result', () => {
    const evaluation = { report: { status: 'pass', issues: [], checks: [], coverage: { graph: 'partial', evidence: {} } }, inspector: null, analysis: null };
    const report = markCompilerObservationStale(evaluation).report;
    assert.equal(report.status, 'warning');
    assert.equal(report.issues[0].code, 'compiler-observation-stale');
    assert.equal(evaluation.report.issues.length, 0);
    assert.equal(report.implementationCheck, 'stale');
});
test('new warning is bilingual and is worded as source evidence, not tested hardware failure', () => {
    for (const locale of ['zh-CN', 'en-US']) {
        const data = JSON.parse(readFileSync(new URL(`../locales/${locale}/health.json`, import.meta.url)));
        assert.ok(data.resourcePreflight.code['interrupt-latency-risk']);
        for (const field of ['reason', 'impact', 'suggestion']) assert.ok(data.resourceInspector.conflictDetails['interrupt-latency-risk'][field]);
        for (const state of ['needs-compile', 'running', 'partial', 'unavailable', 'stale']) {
            assert.ok(data.resourcePreflight.implementation[state]);
            assert.ok(data.resourcePreflight.implementationHelp[state]);
        }
        assert.ok(data.resourcePreflight.compileForResources);
    }
});
test('native command and Workspace integrate post-build; cache is not serialized', () => {
    const workspace = readFileSync(new URL('../components/Workspace.tsx', import.meta.url), 'utf8');
    assert.match(workspace, /invoke<CapturedCompilerSnapshot>\('observe_compiled_resources'/);
    assert.match(workspace, /integrateCompilerResources\(/);
    assert.match(workspace, /currentCompilerResourcePresentation\(/);
    const native = readFileSync(new URL('../../src-tauri/src/compiler_resource_capture.rs', import.meta.url), 'utf8');
    assert.match(native, /fdump-tree-gimple-lineno/);
    assert.doesNotMatch(native, /arduino-cli|lib install|cmd\.exe|powershell\.exe/);
});
test('closeout reuses the existing compile action, drops stale callbacks and exposes unavailable results', () => {
    const workspace = readFileSync(new URL('../components/Workspace.tsx', import.meta.url), 'utf8');
    assert.match(workspace, /onCompileForResources=\{\(\) => \{ void handleCompileAndUpload\(false\); \}\}/);
    assert.match(workspace, /compilerObservationAttemptRef\.current === attempt/);
    assert.match(workspace, /if \(!observationIsCurrent\(\)\) return/);
    assert.match(workspace, /implementationCheck: 'unavailable'/);
    assert.match(workspace, /if \(attempt\.status === 'running'\) attempt\.status = 'unavailable'/);
    assert.match(workspace, /useEffect\(\(\) => \(\) => \{ compilerObservationAttemptRef\.current = null; \}, \[\]\)/);
    const panel = readFileSync(new URL('../components/ResourcePreflightPanel.tsx', import.meta.url), 'utf8');
    assert.match(panel, /disabled=\{isCompiling \|\| isRunning\}/);
    assert.match(panel, /data-check-state=\{report\.implementationCheck\}/);
});
