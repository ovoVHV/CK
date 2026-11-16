import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { loadResourceModule } from './resource_test_loader.mjs';

const { observeCompilerResources } = await loadResourceModule('./compiler_resource_observation.ts');
const { sha256Hex, wrapCompileSourceBoundary, freezeCompileSourceMap } = await loadResourceModule('./compile_source_map.ts');
const { buildHardwareResourceInspector } = await loadResourceModule('./hardware_resource_inspector.ts');
const clone = value => structuredClone(value);
const hash = value => sha256Hex(value);
const context = {
    fqbn: 'fixture:arch:carrier', mcu: 'fixture-chip', variant: 'fixture-routing',
    coreVersion: '1.0.0', fCpu: '1L', options: {},
};
const sketch = '/fixture/probe.ino';
const driver = '/fixture/untouched/src/driver.cpp';
const header = '/fixture/core/Wire.h';
const definition = '/fixture/core/Wire.cpp';
const unit = (file, kind, gimple) => ({
    file, kind, gimple, gimpleSha256: hash(gimple), commandSha256: hash(`command:${file}`),
    dependencies: [file, header],
    definedSymbols: kind === 'library' ? ['arbitraryWrite(unsigned char)'] : ['loop'],
    referencedSymbols: kind === 'library'
        ? ['TwoWire::beginTransmission(unsigned char)', 'TwoWire::write(unsigned char)', 'TwoWire::endTransmission()']
        : ['arbitraryWrite(unsigned char)'],
    ...(kind === 'library' ? { libraryRoot: '/fixture/untouched', libraryVersion: '0.1' } : {}),
});
const locate = text => `[${driver}:8:2] ${text}`;
function driverDump(statements = [
    'TwoWire::beginTransmission (&Wire, address);',
    'TwoWire::write (&Wire, 1);',
    'TwoWire::endTransmission (&Wire);',
]) {
    return `void arbitraryWrite(uint8_t) (uint8_t address)\n{\n${statements.map(locate).join('\n')}\n}\n`;
}
function fixture(body = driverDump()) {
    const code = `void setup() {}\nvoid loop() {\n${wrapCompileSourceBoundary('arbitraryWrite(32);', {
        boundaryId: 'fixture-boundary', blockId: 'original-block-id', blockType: 'third_party_write',
        section: 'loop', confidence: 'exact',
    })}\n}\n`;
    const sources = [sketch, driver, header, definition].map(path => ({ path, sha256: hash(`fixture:${path}`) }));
    const apiEvidence = [{
        callee: 'TwoWire::beginTransmission', commitCallee: 'TwoWire::endTransmission',
        intermediateCallees: ['TwoWire::write'],
        receiver: '&Wire', receiverArgument: 0, addressArgument: 1, resourceAlias: 'i2c',
        headerFile: header, definitionFile: definition,
        definedSymbols: ['TwoWire::beginTransmission(unsigned char)', 'TwoWire::write(unsigned char)', 'TwoWire::endTransmission()'],
        sourceEvidence: clone(sources.filter(source => [header, definition].includes(source.path))), context: clone(context),
    }];
    const input = {
        snapshot: {
            context: clone(context), codeSha256: hash(code), sources,
            compileCommandsSha256: hash('fixture-commands'), graphSha256: '',
            compiledFiles: [sketch, driver, definition],
            units: [
                unit(sketch, 'sketch', `void loop() ()\n{\n[${sketch}:3:2] arbitraryWrite (32);\n}\n`),
                unit(driver, 'library', body),
            ],
        },
        current: { context: clone(context), code, compileCommandsSha256: hash('fixture-commands'), sources: clone(sources) },
        sourceMap: freezeCompileSourceMap(code, { file: sketch }),
        graph: {
            version: 1, coverage: 'full',
            resources: [{ id: 'custom-bus', aliases: ['i2c'], type: 'i2c-controller', sharing: 'address', evidence: ['fixture-source'] }],
            routes: [],
            evidence: [{ id: 'fixture-source', source: 'test-fixture-only', confidence: 'declared' }],
        },
        apiEvidence,
    };
    input.snapshot.graphSha256 = hash(JSON.stringify(input.graph));
    return input;
}
function alterUnit(input, index, transform) {
    const item = input.snapshot.units[index];
    item.gimple = transform(item.gimple);
    item.gimpleSha256 = hash(item.gimple);
    return input;
}
function assertUnknown(input, gap) {
    const result = observeCompilerResources(input);
    assert.equal(result.status, 'Unknown');
    assert.equal(result.claims.length, 0);
    assert.equal(result.analysis, null);
    if (gap) assert.ok(result.gaps.includes(gap), JSON.stringify(result.gaps));
}

test('no package claim input is needed; existing analyzer and third-party graph receive a traced claim', () => {
    const input = fixture();
    const result = observeCompilerResources(input);
    assert.equal(result.status, 'Partial');
    assert.equal(result.claims.length, 1);
    assert.equal(result.claims[0].reference, 'original-block-id');
    assert.equal(result.claims[0].resource, 'custom-bus');
    assert.equal(result.claims[0].discriminator, '32');
    assert.equal(result.analysis.coverage, 'partial', 'recognized subset never promotes full coverage');
    assert.deepEqual(result.traces[0].steps.map(step => step.function), ['arbitraryWrite', 'TwoWire::beginTransmission']);
    const view = buildHardwareResourceInspector({ graph: input.graph, claims: result.claims, analysis: result.analysis });
    assert.equal(view.buses[0].devices[0].reference, 'original-block-id');
    assert.equal(view.buses[0].devices[0].address, '32');
});

test('a simple interprocedural parameter chain is recognized without driver-name mappings', () => {
    const input = fixture();
    const otherFile = '/fixture/untouched/src/helper.cpp';
    const other = unit(otherFile, 'library', driverDump().replaceAll('arbitraryWrite', 'otherName'));
    other.definedSymbols = ['otherName(unsigned char)'];
    input.snapshot.units.push(other);
    input.snapshot.compiledFiles.push(otherFile);
    const source = { path: otherFile, sha256: hash('helper') };
    input.snapshot.sources.push(source);
    input.current.sources.push(clone(source));
    alterUnit(input, 1, () => 'void arbitraryWrite(uint8_t) (uint8_t x)\n{\n'
        + locate('otherName (x);') + '\n}\n');
    input.snapshot.units[1].referencedSymbols = ['otherName(unsigned char)'];
    const result = observeCompilerResources(input);
    assert.equal(result.claims.length, 1);
    assert.deepEqual(result.traces[0].steps.map(step => step.function),
        ['arbitraryWrite', 'otherName', 'TwoWire::beginTransmission']);
});

test('untouched inputs, workspace source mapping, graph and detached output', () => {
    const input = fixture(), before = clone(input);
    const freeze = value => {
        if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
    };
    freeze(input);
    const output = observeCompilerResources(input);
    output.traces[0].apiEvidence[0].sha256 = 'changed';
    output.analysis.bindings[0].resource.id = 'changed';
    assert.deepEqual(input, before);
});

for (const [key, value] of Object.entries({
    fqbn: 'fixture:other:carrier', mcu: 'other-chip', variant: 'other-variant',
    coreVersion: '2.0.0', fCpu: '2L', options: { mode: 'other' },
})) {
    test(`stale ${key} cannot reuse old recognition`, () => {
        const input = fixture();
        input.current.context[key] = value;
        assertUnknown(input, 'recognition.context.stale-or-missing');
    });
}

test('no resolved context is Unknown', () => {
    const input = fixture();
    delete input.current.context;
    assertUnknown(input, 'recognition.context.stale-or-missing');
});

test('changed generated code invalidates the observation and block attribution', () => {
    const input = fixture();
    input.current.code = input.current.code.replace('arbitraryWrite(32)', 'arbitraryWrite(33)');
    assertUnknown(input, 'recognition.code.stale');
});

test('other defines/include order/compiler command changes invalidate old recognition', () => {
    const input = fixture();
    input.current.compileCommandsSha256 = hash('different-commands');
    assertUnknown(input, 'recognition.commands.stale');
});

test('a different graph cannot inherit a previous target observation', () => {
    const input = fixture();
    input.graph.resources[0].id = 'another-bus';
    assertUnknown(input, 'recognition.graph.stale');
});

test('changed library/source content is Unknown even when names and versions match', () => {
    const input = fixture();
    input.current.sources.find(source => source.path === driver).sha256 = hash('changed');
    assertUnknown(input, 'recognition.source.stale');
});

test('tampered compiler dump is rejected', () => {
    const input = fixture();
    input.snapshot.units[0].gimple += '\nchanged';
    assertUnknown(input, 'recognition.compiler-evidence.invalid');
});

test('same API spelling without reviewed selected source evidence proves nothing', () => {
    const input = fixture();
    input.apiEvidence[0].sourceEvidence[0].sha256 = hash('another Wire implementation');
    assertUnknown(input, 'recognition.api-evidence.unverified');
});

test('a header that is not a dependency of this translation unit proves nothing', () => {
    const input = fixture();
    input.snapshot.units[1].dependencies = [driver];
    assertUnknown(input);
});

test('same function spelling with another selected overload is not implementation evidence', () => {
    const input = fixture();
    input.snapshot.units[0].referencedSymbols = ['arbitraryWrite(int)'];
    assertUnknown(input, 'recognition.call.unresolved');
});

test('same API spelling with no matching compiled symbol is not sufficient', () => {
    const input = fixture();
    input.apiEvidence[0].definedSymbols = ['Unrelated::beginTransmission(unsigned char)'];
    assertUnknown(input, 'recognition.call.unresolved');
});

test('a definition that was not in the successful compilation is not selected evidence', () => {
    const input = fixture();
    input.snapshot.compiledFiles = [sketch, driver];
    assertUnknown(input, 'recognition.api-evidence.unverified');
});

test('dead/unreferenced functions do not produce usages', () => {
    const input = fixture();
    alterUnit(input, 0, text => text.replace('arbitraryWrite (32);', 'return;'));
    assertUnknown(input, 'recognition.no-proven-usage');
});

test('conditional transaction is not promoted to unconditional usage', () => {
    const input = fixture(driverDump([
        'if (address != 0) goto <D.1>; else goto <D.2>;',
        '<D.1>:', 'TwoWire::beginTransmission (&Wire, address);', 'TwoWire::endTransmission (&Wire);',
        '<D.2>:', 'return;',
    ]));
    assertUnknown(input, 'recognition.conditional-call.unresolved');
});

test('a transaction after both branches join is recognized', () => {
    const input = fixture(driverDump([
        'if (address != 0) goto <D.1>; else goto <D.2>;',
        '<D.1>:', 'local = 1;', 'goto <D.3>;', '<D.2>:', 'local = 2;', '<D.3>:',
        'TwoWire::beginTransmission (&Wire, address);', 'TwoWire::endTransmission (&Wire);',
    ]));
    assert.equal(observeCompilerResources(input).claims.length, 1);
});

test('goto-skipped transaction is not reported', () => {
    const input = fixture(driverDump([
        'goto <D.1>;', 'TwoWire::beginTransmission (&Wire, address);', 'TwoWire::endTransmission (&Wire);',
        '<D.1>:', 'return;',
    ]));
    assertUnknown(input);
});

test('loops/unsupported control flow fail closed', () => {
    const input = fixture(driverDump([
        '<D.1>:', 'TwoWire::beginTransmission (&Wire, address);', 'TwoWire::endTransmission (&Wire);', 'goto <D.1>;',
    ]));
    assertUnknown(input, 'recognition.control-flow.unsupported');
});

test('dynamic address is not guessed', () => {
    const input = fixture();
    alterUnit(input, 0, text => text.replace('(32)', '(runtimeAddress)'));
    assertUnknown(input, 'recognition.argument.unresolved');
});

test('reassigned or address-taken parameter is not treated as its original value', () => {
    for (const mutation of ['address = 64;', 'mutate (&address);']) {
        const input = fixture(driverDump([
            mutation, 'TwoWire::beginTransmission (&Wire, address);', 'TwoWire::endTransmission (&Wire);',
        ]));
        assertUnknown(input, 'recognition.address.unresolved');
    }
});

test('address outside the verified seven-bit transaction range is unresolved', () => {
    const input = fixture();
    alterUnit(input, 0, text => text.replace('(32)', '(255)'));
    assertUnknown(input, 'recognition.address.unresolved');
});

test('local Wire variable and another receiver do not inherit global Wire semantics', () => {
    assertUnknown(fixture(driverDump([
        'TwoWire Wire;', 'TwoWire::beginTransmission (&Wire, address);', 'TwoWire::endTransmission (&Wire);',
    ])), 'recognition.receiver.shadowed');
    const input = fixture();
    alterUnit(input, 1, text => text.replaceAll('&Wire', '&AnotherWire'));
    assertUnknown(input);
});

test('beginTransmission without a matching unconditional commit is not bus usage', () => {
    assertUnknown(fixture(driverDump(['TwoWire::beginTransmission (&Wire, address);'])), 'recognition.transaction.unresolved');
});

test('unknown calls between begin and commit cannot silently change transaction address', () => {
    assertUnknown(fixture(driverDump([
        'TwoWire::beginTransmission (&Wire, address);', 'unknownCall ();', 'TwoWire::endTransmission (&Wire);',
    ])), 'recognition.transaction.unresolved');
});

test('ambiguous driver function ownership is Unknown, not first-candidate wins', () => {
    const input = fixture();
    alterUnit(input, 1, text => text + '\n' + text);
    assertUnknown(input, 'recognition.call.unresolved');
});

test('missing or ambiguous graph alias cannot allocate a bus', () => {
    const input = fixture();
    input.graph.resources[0].aliases = [];
    input.snapshot.graphSha256 = hash(JSON.stringify(input.graph));
    assertUnknown(input, 'recognition.bus.unresolved');
});

test('low-confidence or another file source map cannot attach the wrong block', () => {
    const input = fixture();
    input.sourceMap = clone(input.sourceMap);
    input.sourceMap.mappings[0].confidence = 'low';
    assertUnknown(input);
});

test('recognition service has no package/board-specific lookup or package declaration dependency', () => {
    const source = readFileSync(new URL('./compiler_resource_observation.ts', import.meta.url), 'utf8');
    for (const forbidden of ['PCF8574', 'ckPcf8574', 'AHT20', 'Servo', 'arduino:avr:uno', 'hardware.claims', 'ck-blocks.json']) {
        assert.equal(source.includes(forbidden), false, forbidden);
    }
});
