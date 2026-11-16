import type { BlockDependency, BlockPackageCompatibility, BlockSearchEntry, LibraryManifest } from '../types/library';
import type { DeclarativeGeneratorRuleV1 } from './declarative_block_runtime';
import type { ResourceBlock } from './resource_claim_binding';
import type { ResourceClaimDeclaration } from './resource_contract';
import type { ResourceAnalysis, ResourceBinding, ResourceClaim, ResourceCoverage } from './hardware_resource_graph';

export type ProviderResolutionStatus = 'Resolved' | 'Partial' | 'Unknown' | 'Conflict';

/** Same shape as the existing compile resourceBoardIdentity observation.
 * Optional properties allow incomplete observations to be reported, not guessed. */
export interface ProviderBoardContext {
    fqbn: string;
    mcu: string;
    variant: string;
    coreVersion: string;
    fCpu?: string;
    options?: Record<string, string>;
}

export interface ProviderBlockRef {
    packageId: string;
    packageVersion?: string;
    blockType: string;
    blockId?: string;
    fields?: Record<string, unknown>;
    inputs?: Record<string, unknown>;
}

export interface ProviderWorkspaceBlock extends ResourceBlock {
    inputList?: readonly {
        name?: string;
        fieldRow: readonly { name?: string; getValue(): unknown }[];
    }[];
}

export interface ProviderGeneratorEvidence {
    sourcePackage: string;
    sourcePath: string;
    /** Actual validated JSON rule, not manifest.generation documentation. */
    rule?: Readonly<DeclarativeGeneratorRuleV1>;
    /** For a built-in generator already identified by its existing binding. */
    builtinBinding?: { blockType: string; evidenceRefs: readonly string[] };
    ownershipEvidence: readonly string[];
}

/** An implementation may combine several sources, not just one library. */
export interface ProviderImplementationEvidence {
    ref: string;
    kind: 'package-src' | 'external-library' | 'core-api' | 'sdk-hal' | 'vendor' | 'other';
    sourcePaths: readonly string[];
    version?: string;
    contentSha256?: string;
    boardContext?: ProviderBoardContext;
    evidenceRefs: readonly string[];
    includes?: readonly string[];
    calls?: readonly string[];
    /** Existing, source-attributed facts only. Never inferred from a name. */
    details?: Readonly<Record<string, string>>;
}

/** Ephemeral correlation reference, not a new package entity or registry ID. */
export interface ProviderCandidate {
    ref: string;
    packageId: string;
    packageVersion?: string;
    blockType: string;
    generator?: ProviderGeneratorEvidence;
    implementation: readonly ProviderImplementationEvidence[];
    declaredSupport?: BlockPackageCompatibility;
    evidenceRefs: readonly string[];
    unresolved?: readonly string[];
}

export interface ProviderSelectionObservation {
    candidateRef: string;
    boardContext: ProviderBoardContext;
    blockId?: string;
    blockSnapshot?: Pick<ProviderBlockRef, 'fields' | 'inputs'>;
    /** Selection must already exist; this service does not choose a candidate. */
    evidenceRefs: readonly string[];
    dependencyBindings: readonly {
        kind: BlockDependency['kind'];
        id: string;
        implementationRef: string;
        evidenceRefs: readonly string[];
        /** For external libraries: exact path from the existing resolver output. */
        selectedLibraryPath?: string;
        /** Existing constraint-check result only; no version solver here. */
        versionConstraintSatisfied?: boolean;
    }[];
}

export interface ProviderClaimObservation {
    blockId: string;
    boardContext: ProviderBoardContext;
    blockSnapshot?: Pick<ProviderBlockRef, 'fields' | 'inputs'>;
    claims: readonly ResourceClaim[];
    bindings: readonly ResourceBinding[];
    coverage: ResourceCoverage;
    gaps: readonly { code: string; block?: string; claim?: string; resource?: string }[];
    conflicts: ResourceAnalysis['conflicts'];
    evidenceRefs: readonly string[];
}

export interface ProviderResolutionInput {
    blockRef: ProviderBlockRef;
    workspaceBlock?: ProviderWorkspaceBlock;
    catalog: readonly BlockSearchEntry[];
    packageDependencies?: readonly BlockDependency[];
    libraryMetadata?: readonly LibraryManifest[];
    /** Existing compile result fields. Paths alone do not identify a Provider. */
    libraryResolverResult?: {
        customLibraries: readonly string[];
        arduinoLibraries: readonly string[];
    };
    candidates: readonly ProviderCandidate[];
    selections?: readonly ProviderSelectionObservation[];
    boardContext?: ProviderBoardContext;
    claimObservation?: ProviderClaimObservation;
}

export interface ResolvedProviderResult {
    status: ProviderResolutionStatus;
    blockRef: ProviderBlockRef;
    candidates: readonly ProviderCandidate[];
    /** Present only when an existing, context-matching observation selects it. */
    selectedCandidateRef?: string;
    generator?: ProviderGeneratorEvidence;
    implementation: readonly ProviderImplementationEvidence[];
    dependencies: {
        package: readonly BlockDependency[];
        /** Catalog may already have package dependencies merged into this list. */
        catalog: readonly BlockDependency[];
        combined: readonly BlockDependency[];
        libraryMetadata: readonly LibraryManifest[];
        resolver?: ProviderResolutionInput['libraryResolverResult'];
    };
    claims: {
        declaration?: ResourceClaimDeclaration;
        observation?: ProviderClaimObservation;
    };
    boardContext?: ProviderBoardContext;
    selectionObservations: readonly ProviderSelectionObservation[];
    unresolved: string[];
    evidenceRefs: string[];
}

export type ProviderCandidateSelectionStatus = 'selected' | 'ambiguous' | 'unknown';

export interface ProviderCandidateSelection {
    status: ProviderCandidateSelectionStatus;
    candidateRef?: string;
    reasonCodes: string[];
    evidenceRefs: string[];
}

export interface ProviderCandidateSelectionInput {
    blockRef: Pick<ProviderBlockRef, 'packageId' | 'blockType'>;
    boardContext?: ProviderBoardContext;
    candidates: readonly ProviderCandidate[];
}

const hasText = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const hasRefs = (refs: readonly string[] | undefined): boolean => !!refs?.some(hasText);
const completeContext = (context: ProviderBoardContext | undefined): boolean => !!context
    && [context.fqbn, context.mcu, context.variant, context.coreVersion, context.fCpu].every(hasText)
    && !!context.options && !Array.isArray(context.options)
    && typeof context.options === 'object'
    && Object.values(context.options).every(value => typeof value === 'string');

function sameContext(a: ProviderBoardContext, b: ProviderBoardContext): boolean {
    const keys = ['fqbn', 'mcu', 'variant', 'coreVersion', 'fCpu'] as const;
    return completeContext(a) && completeContext(b) && keys.every(key => a[key] === b[key])
        && Object.keys(a.options!).length === Object.keys(b.options!).length
        && Object.entries(a.options!).every(([key, value]) => b.options![key] === value);
}

/** Compare validated data without making object insertion order an identity. */
function sameData(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
    if (Array.isArray(a) || Array.isArray(b)) {
        return Array.isArray(a) && Array.isArray(b) && a.length === b.length
            && a.every((value, index) => sameData(value, b[index]));
    }
    const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
    return Object.keys(left).length === Object.keys(right).length
        && Object.keys(left).every(key => Object.prototype.hasOwnProperty.call(right, key) && sameData(left[key], right[key]));
}

const sameBlockSnapshot = (snapshot: Pick<ProviderBlockRef, 'fields' | 'inputs'>, ref: ProviderBlockRef): boolean =>
    sameData(snapshot.fields ?? {}, ref.fields ?? {}) && sameData(snapshot.inputs ?? {}, ref.inputs ?? {});

function hasLibrarySource(paths: readonly string[], root: string): boolean {
    const clean = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '');
    const base = clean(root);
    // Do not guess aliases/case or canonical paths. Caller supplies resolver paths.
    return paths.some(path => clean(path) === base || clean(path).startsWith(`${base}/`));
}

function snapshotBlock(ref: ProviderBlockRef, block: ProviderWorkspaceBlock, entry?: BlockSearchEntry): ProviderBlockRef {
    const names = new Set([
        ...(entry?.fields ?? []).map(field => field.name),
        ...(block.inputList ?? []).flatMap(input => input.fieldRow.flatMap(field => field.name ? [field.name] : [])),
    ]);
    const inputNames = new Set([
        ...(entry?.inputs ?? []).map(input => input.name),
        ...(block.inputList ?? []).flatMap(input => input.name ? [input.name] : []),
    ]);
    return {
        ...ref,
        blockId: block.id,
        blockType: block.type,
        fields: Object.fromEntries([...names].map(name => [name, block.getFieldValue(name)])),
        inputs: Object.fromEntries([...inputNames].map(name => {
            const target = block.getInputTargetBlock(name) as ProviderWorkspaceBlock | null;
            // Capture operand identity/fields, never evaluate an expression or run a generator.
            return [name, target ? {
                blockId: target.id,
                blockType: target.type,
                fields: Object.fromEntries((target.inputList ?? []).flatMap(input =>
                    input.fieldRow.flatMap(field => field.name ? [[field.name, field.getValue()]] : []))),
            } : null];
        })),
    };
}

function combinedDependencies(dependencies: readonly BlockDependency[]): BlockDependency[] {
    const seen = new Set<string>();
    return dependencies.filter(dependency => {
        const key = JSON.stringify([dependency.kind, dependency.id, dependency.version ?? '', [...(dependency.headers ?? [])].sort()]);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

/**
 * Pure internal prototype over validated, already available material.
 * No I/O, source parsing, candidate scoring, compatibility rules or allocation.
 * The result is detached data; it is never persisted into project/build identity.
 */
export function resolveProviderForBlock(input: ProviderResolutionInput): ResolvedProviderResult {
    const unresolved = new Set<string>();
    let conflict = false;
    const contradict = (code: string) => { conflict = true; unresolved.add(code); };
    const entries = input.catalog.filter(entry =>
        entry.type === input.blockRef.blockType && entry.library_id === input.blockRef.packageId);
    const entry = entries.length === 1 ? entries[0] : undefined;
    if (!entries.length) unresolved.add('block.catalog.missing');
    if (entries.length > 1) contradict('block.catalog.ambiguous');
    if (input.workspaceBlock && (input.workspaceBlock.type !== input.blockRef.blockType
        || (input.blockRef.blockId !== undefined && input.workspaceBlock.id !== input.blockRef.blockId))) {
        contradict('block.instance.mismatch');
    }
    const blockRef = input.workspaceBlock
        ? snapshotBlock(input.blockRef, input.workspaceBlock, entry)
        : input.blockRef;
    if (!blockRef.blockId) unresolved.add('block.instance.missing');
    if (!hasText(blockRef.packageVersion)) unresolved.add('block.package-version.unknown');
    if (!input.boardContext) unresolved.add('board.context.missing');
    else if (!completeContext(input.boardContext)) unresolved.add('board.context.incomplete');

    const candidates = input.candidates.filter(candidate =>
        candidate.blockType === blockRef.blockType && candidate.packageId === blockRef.packageId);
    if (!candidates.length) unresolved.add('provider.candidate.missing');
    if (new Set(candidates.map(candidate => candidate.ref)).size !== candidates.length) {
        contradict('provider.candidate-reference.ambiguous');
    }
    const observations = input.selections ?? [];
    const matches = observations.filter(observation => input.boardContext
        && sameContext(observation.boardContext, input.boardContext));
    if (matches.length !== observations.length) unresolved.add('provider.selection.stale-context');
    const selectedRefs = new Set(matches.map(observation => observation.candidateRef));
    if (selectedRefs.size > 1) contradict('provider.selection.contradictory');
    const selection = matches.length === 1 ? matches[0] : undefined;
    if (matches.length > 1 && selectedRefs.size === 1) unresolved.add('provider.selection.duplicate-observation');
    let selected: ProviderCandidate | undefined;
    if (selection) {
        const selectedCandidates = candidates.filter(candidate => candidate.ref === selection.candidateRef);
        if (selectedCandidates.length !== 1) contradict('provider.selection.candidate-mismatch');
        else if (!hasRefs(selection.evidenceRefs)) unresolved.add('provider.selection.evidence-missing');
        else if ((selection.blockId && selection.blockId !== blockRef.blockId)
            || (selection.blockSnapshot && !sameBlockSnapshot(selection.blockSnapshot, blockRef))) {
            unresolved.add('provider.selection.stale-instance');
        } else {
            selected = selectedCandidates[0];
            if (!selection.blockId || !selection.blockSnapshot) unresolved.add('provider.selection.instance-unverified');
        }
    }
    if (!selected) unresolved.add('provider.not-selected');

    const dependencies = combinedDependencies([...(input.packageDependencies ?? []), ...(entry?.dependencies ?? [])]);
    if (selected) {
        for (const code of selected.unresolved ?? []) unresolved.add(code);
        if (selected.packageVersion && blockRef.packageVersion && selected.packageVersion !== blockRef.packageVersion) {
            contradict('provider.package-version.mismatch');
        }
        if (!selected.packageVersion) unresolved.add('provider.package-version.unknown');
        if (!hasRefs(selected.evidenceRefs)) unresolved.add('provider.evidence.missing');
        const generator = selected.generator;
        if (!generator?.rule && !generator?.builtinBinding) unresolved.add('generator.rule.missing');
        if (!generator || !hasRefs(generator.ownershipEvidence) || !hasText(generator.sourcePath)) {
            unresolved.add('generator.ownership.unresolved');
        }
        if (generator && generator.sourcePackage !== blockRef.packageId) contradict('generator.owner.mismatch');
        if (generator?.rule && generator.rule.type !== blockRef.blockType) contradict('generator.rule-type.mismatch');
        if (generator?.builtinBinding && (generator.builtinBinding.blockType !== blockRef.blockType
            || !hasRefs(generator.builtinBinding.evidenceRefs))) contradict('generator.builtin-binding.mismatch');

        const implementations = selected.implementation;
        if (!implementations.length) unresolved.add('implementation.evidence.missing');
        if (new Set(implementations.map(part => part.ref)).size !== implementations.length) {
            contradict('implementation.reference.ambiguous');
        }
        for (const part of implementations) {
            if (!hasText(part.ref) || !hasRefs(part.sourcePaths) || !hasRefs(part.evidenceRefs)) {
                unresolved.add('implementation.evidence.missing');
            }
            if (!hasText(part.contentSha256) && !hasText(part.version)) unresolved.add('implementation.content.unknown');
            if (part.boardContext && input.boardContext && !sameContext(part.boardContext, input.boardContext)) {
                contradict('implementation.target.mismatch');
            }
            if (['core-api', 'sdk-hal', 'vendor'].includes(part.kind) && !part.boardContext) {
                unresolved.add('implementation.target.unknown');
            }
        }
        // Correlate explicit prior bindings only. Names/headers never choose an implementation.
        for (const dependency of dependencies.filter(dependency => !dependency.optional)) {
            const bindings = selection!.dependencyBindings.filter(binding =>
                binding.kind === dependency.kind && binding.id === dependency.id);
            if (bindings.length === 0) { unresolved.add('dependency.implementation-link.missing'); continue; }
            if (bindings.length > 1) { contradict('dependency.binding.ambiguous'); continue; }
            const binding = bindings[0];
            const part = implementations.find(item => item.ref === binding.implementationRef);
            if (!part) { contradict('dependency.implementation.mismatch'); continue; }
            if (!hasRefs(binding.evidenceRefs)) unresolved.add('dependency.binding.evidence-missing');
            if (!dependency.version) unresolved.add('dependency.version.unspecified');
            else if (binding.versionConstraintSatisfied === false) contradict('dependency.version-constraint.unsatisfied');
            else if (binding.versionConstraintSatisfied !== true) unresolved.add('dependency.version-constraint.unverified');
            if (dependency.kind === 'arduino-library' || part.kind === 'external-library') {
                const paths = [...(input.libraryResolverResult?.customLibraries ?? []),
                    ...(input.libraryResolverResult?.arduinoLibraries ?? [])];
                if (!binding.selectedLibraryPath || !paths.includes(binding.selectedLibraryPath)) {
                    unresolved.add('dependency.library-selection.unconfirmed');
                } else if (!hasLibrarySource(part.sourcePaths, binding.selectedLibraryPath)) {
                    unresolved.add('dependency.library-source.unconfirmed');
                }
                if (!part.version) unresolved.add('dependency.library-version.unknown');
            }
        }
    }

    const declaration = entry?.hardware?.claims;
    if (!declaration) unresolved.add('claims.declaration.missing');
    else if (declaration.coverage !== 'full') unresolved.add('claims.coverage.incomplete');
    const observation = input.claimObservation;
    const claimMatches = observation && input.boardContext && sameContext(observation.boardContext, input.boardContext)
        && observation.blockId === blockRef.blockId
        && (!observation.blockSnapshot || sameBlockSnapshot(observation.blockSnapshot, blockRef));
    if (!observation) unresolved.add('claims.binding.missing');
    else if (!claimMatches) unresolved.add('claims.binding.stale-context');
    else {
        if (!observation.blockSnapshot) unresolved.add('claims.binding.instance-unverified');
        if (observation.coverage !== 'full' || observation.gaps.length) unresolved.add('claims.binding.incomplete');
        if (!hasRefs(observation.evidenceRefs)) unresolved.add('claims.evidence.missing');
        if (declaration?.templates.length && (!observation.claims.length || !observation.bindings.length)) {
            unresolved.add('claims.binding.empty');
        }
        if (observation.claims.some(claim => claim.reference !== blockRef.blockId)
            || observation.bindings.some(binding => binding.claim.reference !== blockRef.blockId)) {
            contradict('claims.binding.instance-mismatch');
        }
        if (observation.claims.some(claim => !observation.bindings.some(binding =>
            binding.claim.id === claim.id && binding.resource.id === claim.resource && sameData(binding.claim, claim)))) {
            unresolved.add('claims.binding.unmatched');
        }
        // Resource conflicts remain resource facts, never Provider selection conflicts.
    }
    const evidenceRefs = new Set<string>();
    for (const candidate of candidates) {
        for (const ref of candidate.evidenceRefs) evidenceRefs.add(ref);
        for (const ref of candidate.generator?.ownershipEvidence ?? []) evidenceRefs.add(ref);
        for (const part of candidate.implementation) for (const ref of part.evidenceRefs) evidenceRefs.add(ref);
    }
    for (const observation of observations) for (const ref of observation.evidenceRefs) evidenceRefs.add(ref);
    for (const ref of input.claimObservation?.evidenceRefs ?? []) evidenceRefs.add(ref);
    const status: ProviderResolutionStatus = !completeContext(input.boardContext) ? 'Unknown'
        : conflict ? 'Conflict'
        : !entry || !candidates.length ? 'Unknown'
        : unresolved.size ? 'Partial' : 'Resolved';

    // All cloned values are internal validated data, not Blockly instances/functions.
    return structuredClone({
        status,
        blockRef,
        candidates,
        ...(selected ? { selectedCandidateRef: selected.ref, generator: selected.generator } : {}),
        implementation: selected?.implementation ?? [],
        dependencies: {
            package: input.packageDependencies ?? [],
            catalog: entry?.dependencies ?? [],
            combined: dependencies,
            libraryMetadata: input.libraryMetadata ?? [],
            ...(input.libraryResolverResult ? { resolver: input.libraryResolverResult } : {}),
        },
        claims: {
            ...(declaration ? { declaration } : {}),
            ...(claimMatches ? { observation } : {}),
        },
        ...(input.boardContext ? { boardContext: input.boardContext } : {}),
        selectionObservations: observations,
        unresolved: [...unresolved].sort(),
        evidenceRefs: [...evidenceRefs].filter(hasText).sort(),
    });
}

function supportSelectorMatches(
    selectors: readonly string[] | undefined,
    values: readonly string[],
): 'match' | 'mismatch' | 'unspecified' {
    if (!selectors || selectors.length === 0) return 'unspecified';
    const normalized = selectors.map(value => value.trim().toLowerCase()).filter(Boolean);
    if (normalized.includes('*')) return 'match';
    return normalized.some(selector => values.some(value => value.toLowerCase() === selector))
        ? 'match'
        : 'mismatch';
}

function candidateSupportMatches(
    candidate: ProviderCandidate,
    context: ProviderBoardContext,
): 'match' | 'mismatch' {
    const parts = context.fqbn.trim().toLowerCase().split(':');
    const coreId = parts.length >= 2 ? parts.slice(0, 2).join(':') : '';
    const boardId = parts.length >= 3 ? parts[2].split(',')[0] : '';
    const boardValues = [context.fqbn, parts.slice(0, 3).join(':'), boardId, coreId].filter(Boolean);
    const architectureValues = [parts[1] || '', coreId].filter(Boolean);
    const support = candidate.declaredSupport;
    if (!support) return 'match';
    const board = supportSelectorMatches(support.boards, boardValues);
    const architecture = supportSelectorMatches(support.architectures, architectureValues);
    return board === 'mismatch' || architecture === 'mismatch' ? 'mismatch' : 'match';
}

/**
 * Selects a Provider only when the caller has supplied a closed candidate set
 * and exactly one candidate has target/evidence proof for the exact resolved
 * Board context. This is deliberately separate from resolveProviderForBlock:
 * existing production observations remain authoritative, while callers that
 * opt into bounded automatic selection can use this gate before creating an
 * observation. No library name, display name or board default is used.
 */
export function selectUniqueProviderCandidate(
    input: ProviderCandidateSelectionInput,
): ProviderCandidateSelection {
    const reasons = new Set<string>();
    const evidence = new Set<string>();
    if (!input.boardContext || !completeContext(input.boardContext)) {
        return { status: 'unknown', reasonCodes: ['board.context.incomplete'], evidenceRefs: [] };
    }
    const candidates = input.candidates.filter(candidate =>
        candidate.packageId === input.blockRef.packageId && candidate.blockType === input.blockRef.blockType);
    if (!candidates.length) {
        return { status: 'unknown', reasonCodes: ['provider.candidate.missing'], evidenceRefs: [] };
    }
    if (new Set(candidates.map(candidate => candidate.ref)).size !== candidates.length) {
        return { status: 'ambiguous', reasonCodes: ['provider.candidate-reference.ambiguous'], evidenceRefs: [] };
    }

    const eligible = candidates.filter(candidate => {
        let valid = true;
        if (candidateSupportMatches(candidate, input.boardContext!) === 'mismatch') {
            reasons.add('candidate.support.mismatch');
            valid = false;
        }
        if (candidate.unresolved?.length) {
            for (const unresolved of candidate.unresolved) reasons.add(unresolved);
            valid = false;
        }
        if (!hasRefs(candidate.evidenceRefs)) {
            reasons.add('provider.evidence.missing');
            valid = false;
        } else {
            candidate.evidenceRefs.filter(hasText).forEach(ref => evidence.add(ref));
        }
        const generator = candidate.generator;
        if (!generator || (!generator.rule && !generator.builtinBinding)
            || !hasText(generator.sourcePath) || !hasRefs(generator.ownershipEvidence)) {
            reasons.add('generator.evidence.incomplete');
            valid = false;
        } else {
            generator.ownershipEvidence.filter(hasText).forEach(ref => evidence.add(ref));
        }
        if (!candidate.implementation.length) {
            reasons.add('implementation.evidence.missing');
            valid = false;
        }
        let targetEvidence = false;
        for (const part of candidate.implementation) {
            if (!hasText(part.ref) || !hasRefs(part.sourcePaths) || !hasRefs(part.evidenceRefs)) {
                reasons.add('implementation.evidence.incomplete');
                valid = false;
                continue;
            }
            part.evidenceRefs.filter(hasText).forEach(ref => evidence.add(ref));
            if (part.boardContext) {
                if (!sameContext(part.boardContext, input.boardContext!)) {
                    reasons.add('implementation.target.mismatch');
                    valid = false;
                } else {
                    targetEvidence = true;
                }
            }
        }
        // A wildcard/generic candidate without an exact target or explicit
        // non-wildcard support declaration is not safe to auto-select.
        const declaredTarget = Boolean(
            candidate.declaredSupport?.boards?.some(value => value.trim() && value.trim() !== '*')
            || candidate.declaredSupport?.architectures?.some(value => value.trim() && value.trim() !== '*'),
        );
        if (!targetEvidence && !declaredTarget) {
            reasons.add('provider.target-evidence.missing');
            valid = false;
        }
        return valid;
    });

    if (eligible.length !== 1) {
        if (eligible.length > 1) reasons.add('provider.candidate.ambiguous');
        if (eligible.length === 0 && !reasons.size) reasons.add('provider.candidate.ineligible');
        return {
            status: eligible.length > 1 ? 'ambiguous' : 'unknown',
            reasonCodes: [...reasons].sort(),
            evidenceRefs: [...evidence].sort(),
        };
    }
    const selected = eligible[0];
    return {
        status: 'selected',
        candidateRef: selected.ref,
        reasonCodes: [],
        evidenceRefs: [...evidence].sort(),
    };
}

/**
 * Convenience boundary for callers that explicitly opt into the bounded
 * automatic-selection policy. Existing selection observations win; otherwise
 * the unique-candidate gate creates an ephemeral, instance-scoped observation
 * and reuses the same resolver/validation path. No selection is persisted.
 */
export function resolveProviderWithUniqueSelection(
    input: ProviderResolutionInput,
): ResolvedProviderResult {
    if (input.selections?.length) return resolveProviderForBlock(input);
    const selection = selectUniqueProviderCandidate({
        blockRef: input.blockRef,
        boardContext: input.boardContext,
        candidates: input.candidates,
    });
    if (selection.status !== 'selected' || !selection.candidateRef || !input.boardContext) {
        return resolveProviderForBlock(input);
    }
    const entry = input.catalog.find(item =>
        item.type === input.blockRef.blockType && item.library_id === input.blockRef.packageId);
    const current = input.workspaceBlock
        ? snapshotBlock(input.blockRef, input.workspaceBlock, entry)
        : input.blockRef;
    const blockSnapshot = current.fields || current.inputs
        ? { fields: current.fields, inputs: current.inputs }
        : undefined;
    const observation: ProviderSelectionObservation = {
        candidateRef: selection.candidateRef,
        boardContext: input.boardContext,
        ...(current.blockId ? { blockId: current.blockId } : {}),
        ...(blockSnapshot ? { blockSnapshot } : {}),
        evidenceRefs: selection.evidenceRefs,
        dependencyBindings: [],
    };
    return resolveProviderForBlock({
        ...input,
        selections: [observation],
    });
}
