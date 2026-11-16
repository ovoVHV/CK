import assert from 'node:assert/strict';
import test from 'node:test';
import { loadResourceModule } from './resource_test_loader.mjs';

const { selectUniqueProviderCandidate, resolveProviderWithUniqueSelection } =
    await loadResourceModule('./provider_resolution.ts');
const { evaluateProviderCompatibility } = await loadResourceModule('./provider_compatibility.ts');

const uno = {
    fqbn: 'arduino:avr:uno',
    mcu: 'atmega328p',
    variant: 'standard',
    coreVersion: '1.8.8',
    fCpu: '16000000L',
    options: {},
};
const c6 = {
    fqbn: 'esp32:esp32:esp32c6',
    mcu: 'esp32c6',
    variant: 'esp32c6',
    coreVersion: '3.3.6',
    fCpu: '160000000L',
    options: {},
};

const implementation = (ref, context) => ({
    ref,
    kind: 'core-api',
    sourcePaths: [`evidence/${ref}.cpp`],
    version: context.coreVersion,
    boardContext: structuredClone(context),
    evidenceRefs: [`compile:${ref}`],
});

const candidate = (ref, context, support = { architectures: ['*'], boards: ['*'] }) => ({
    ref,
    packageId: 'fixture-package',
    packageVersion: '1.0.0',
    blockType: 'fixture_block',
    generator: {
        sourcePackage: 'fixture-package',
        sourcePath: 'blocks/generator.json',
        builtinBinding: { blockType: 'fixture_block', evidenceRefs: ['generator:fixture'] },
        ownershipEvidence: ['generator:fixture'],
    },
    implementation: [implementation(ref, context)],
    declaredSupport: support,
    evidenceRefs: [`candidate:${ref}`],
});

const resolvedProvider = (overrides = {}) => ({
    status: 'Resolved',
    blockRef: {
        packageId: 'fixture-package',
        packageVersion: '1.0.0',
        blockType: 'fixture_block',
        blockId: 'block-1',
    },
    candidates: [candidate('uno', uno)],
    selectedCandidateRef: 'uno',
    implementation: [implementation('uno', uno)],
    dependencies: { package: [], catalog: [], combined: [], libraryMetadata: [] },
    claims: {},
    boardContext: structuredClone(uno),
    selectionObservations: [],
    unresolved: [],
    evidenceRefs: ['candidate:uno', 'compile:uno'],
    ...overrides,
});

const completeAnalysis = {
    coverage: 'full',
    bindings: [],
    conflicts: [],
    gaps: [],
    usages: [],
};

test('unique exact target candidate is selected without using a board display name', () => {
    const result = selectUniqueProviderCandidate({
        blockRef: { packageId: 'fixture-package', blockType: 'fixture_block' },
        boardContext: uno,
        candidates: [
            candidate('uno', uno),
            candidate('c6', c6),
        ],
    });
    assert.equal(result.status, 'selected');
    assert.equal(result.candidateRef, 'uno');
    assert.deepEqual(result.reasonCodes, []);
});

test('bounded automatic selection reuses the existing resolver and stays ephemeral', () => {
    const selected = resolveProviderWithUniqueSelection({
        blockRef: {
            packageId: 'fixture-package',
            packageVersion: '1.0.0',
            blockType: 'fixture_block',
            blockId: 'block-1',
        },
        catalog: [{
            type: 'fixture_block',
            library_id: 'fixture-package',
            keywords: [],
            source: 'manifest',
        }],
        candidates: [candidate('uno', uno)],
        boardContext: uno,
    });
    assert.equal(selected.selectedCandidateRef, 'uno');
    assert.equal(selected.implementation[0].ref, 'uno');
    assert.equal(selected.selectionObservations.length, 1);
    assert.ok(selected.unresolved.includes('claims.declaration.missing'));
});

test('two exact candidates remain ambiguous', () => {
    const second = candidate('uno-alt', uno);
    const result = selectUniqueProviderCandidate({
        blockRef: { packageId: 'fixture-package', blockType: 'fixture_block' },
        boardContext: uno,
        candidates: [candidate('uno', uno), second],
    });
    assert.equal(result.status, 'ambiguous');
    assert.equal(result.candidateRef, undefined);
    assert.ok(result.reasonCodes.includes('provider.candidate.ambiguous'));
});

test('generic wildcard material without exact target evidence is not auto-selected', () => {
    const generic = candidate('generic', uno);
    delete generic.implementation[0].boardContext;
    const result = selectUniqueProviderCandidate({
        blockRef: { packageId: 'fixture-package', blockType: 'fixture_block' },
        boardContext: uno,
        candidates: [generic],
    });
    assert.equal(result.status, 'unknown');
    assert.equal(result.candidateRef, undefined);
    assert.ok(result.reasonCodes.includes('provider.target-evidence.missing'));
});

test('resolved provider with complete evidence is Supported', () => {
    const result = evaluateProviderCompatibility({
        provider: resolvedProvider(),
        boardContext: uno,
        resourceAnalysis: completeAnalysis,
    });
    assert.equal(result.status, 'Supported');
    assert.equal(result.resourceImpact, 'None');
    assert.equal(result.selectedCandidateRef, 'uno');
});

test('provider gaps remain Partial and are not upgraded by a clean resource graph', () => {
    const result = evaluateProviderCompatibility({
        provider: resolvedProvider({ status: 'Partial', unresolved: ['dependency.version.unknown'] }),
        boardContext: uno,
        resourceAnalysis: completeAnalysis,
    });
    assert.equal(result.status, 'Partial');
    assert.equal(result.resourceImpact, 'None');
    assert.ok(result.reasonCodes.includes('dependency.version.unknown'));
    assert.ok(result.unmetConditions.includes('dependency.version.unknown'));
});

test('explicit architecture mismatch is Unsupported', () => {
    const result = evaluateProviderCompatibility({
        provider: resolvedProvider({
            candidates: [candidate('uno', uno, { architectures: ['esp32'], boards: ['*'] })],
        }),
        boardContext: uno,
        resourceAnalysis: completeAnalysis,
    });
    assert.equal(result.status, 'Unsupported');
    assert.ok(result.reasonCodes.includes('declared-support.mismatch'));
});

test('missing exact board context is Unknown', () => {
    const result = evaluateProviderCompatibility({
        provider: resolvedProvider(),
        resourceAnalysis: completeAnalysis,
    });
    assert.equal(result.status, 'Unknown');
    assert.ok(result.reasonCodes.includes('board.context.incomplete'));
});

test('resource conflict is reported separately from Provider compatibility', () => {
    const result = evaluateProviderCompatibility({
        provider: resolvedProvider(),
        boardContext: uno,
        resourceAnalysis: {
            ...completeAnalysis,
            conflicts: [{ code: 'exclusive-conflict', resource: 'timer1', claims: ['a', 'b'] }],
        },
    });
    assert.equal(result.status, 'Supported');
    assert.equal(result.resourceImpact, 'Conflict');
    assert.ok(result.reasonCodes.includes('resource.conflict'));
});

test('missing resource facts cannot be presented as fully compatible', () => {
    const result = evaluateProviderCompatibility({
        provider: resolvedProvider(),
        boardContext: uno,
    });
    assert.equal(result.status, 'Partial');
    assert.equal(result.resourceImpact, 'Unknown');
    assert.ok(result.unmetConditions.includes('resource-analysis-available'));
});
