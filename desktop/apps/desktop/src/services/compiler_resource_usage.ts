import type { ResourceClaim } from './hardware_resource_graph';
import type { CompilerResourceTrace, VerifiedPrimitiveApiEvidence } from './compiler_resource_observation';

export type CompilerResourceKind =
    | 'gpio'
    | 'adc'
    | 'i2c'
    | 'spi'
    | 'uart'
    | 'pwm'
    | 'timer'
    | 'tone'
    | 'interrupt'
    | 'unknown';

export interface CompilerLibraryResourceUsage {
    /** The selected compiled library root, or the exact implementation file
     * when the call came directly from the sketch/Core. */
    implementation: string;
    version?: string;
    kinds: CompilerResourceKind[];
    resources: string[];
    roles: string[];
    blockReferences: string[];
    evidence: { path: string; sha256: string }[];
    /** This is source-backed observation coverage, not a hardware guarantee. */
    status: 'observed' | 'partial';
    unresolved: string[];
}

interface UsageInput {
    traces: readonly CompilerResourceTrace[];
    claims?: readonly ResourceClaim[];
    gaps?: readonly string[];
}

const operationKinds = (operation: VerifiedPrimitiveApiEvidence['kind'] | undefined): CompilerResourceKind[] => {
    switch (operation) {
        case 'gpio-output':
        case 'gpio-input':
        case 'pin-mode':
            return ['gpio'];
        case 'adc':
            return ['adc'];
        case 'pwm':
            return ['pwm'];
        case 'uart':
            return ['uart'];
        case 'spi':
            return ['spi'];
        case 'servo-attach':
            return ['pwm', 'timer'];
        case 'tone':
            return ['tone', 'timer'];
        case 'interrupt-blocking':
            return ['interrupt'];
        default:
            return [];
    }
};

const claimKinds = (claim: ResourceClaim | undefined): CompilerResourceKind[] => {
    if (!claim) return [];
    const role = claim.role.toLowerCase();
    if (role.startsWith('i2c-')) return ['i2c'];
    if (role.startsWith('spi-')) return ['spi'];
    if (role.includes('uart') || role.includes('serial')) return ['uart'];
    if (role.includes('servo')) return ['pwm', 'timer'];
    if (role.includes('tone')) return ['tone', 'timer'];
    if (role.includes('pwm')) return ['pwm'];
    if (role.includes('adc') || role.includes('analog')) return ['adc'];
    if (role.includes('interrupt')) return ['interrupt'];
    if (role.includes('gpio') || role.includes('digital')) return ['gpio'];
    return [];
};

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];

const implementationKey = (trace: CompilerResourceTrace): string =>
    trace.implementation.libraryRoot.trim() || trace.implementation.file.trim();

const unresolvedForKinds = (
    kinds: readonly CompilerResourceKind[],
    gaps: readonly string[],
): string[] => {
    const relevant = gaps.filter(gap => {
        if (gap.includes('spi')) return kinds.includes('spi');
        if (gap.includes('i2c') || gap.includes('address') || gap.includes('transaction') || gap.includes('bus')) {
            return kinds.includes('i2c');
        }
        if (gap.includes('uart')) return kinds.includes('uart');
        if (gap.includes('pwm') || gap.includes('timer')) return kinds.includes('pwm') || kinds.includes('timer');
        if (gap.includes('interrupt')) return kinds.includes('interrupt');
        // Project-wide recognition coverage and unrelated unsupported calls do
        // not invalidate a row that already has a verified trace. The panel
        // still explains the overall partial coverage separately.
        return false;
    });
    return unique(relevant).sort();
};

/**
 * Groups already verified compiler traces by the implementation selected by
 * the successful build. This is deliberately not a library-name scanner:
 * no package name, include string or symbol spelling can create a usage row.
 * A row exists only when the existing compiler observer emitted a trace.
 */
export function summarizeCompilerLibraryResourceUsage(input: UsageInput): CompilerLibraryResourceUsage[] {
    const claims = new Map((input.claims ?? []).map(claim => [claim.id, claim]));
    const groups = new Map<string, {
        implementation: string;
        version?: string;
        kinds: Set<CompilerResourceKind>;
        resources: Set<string>;
        roles: Set<string>;
        blockReferences: Set<string>;
        evidence: Map<string, { path: string; sha256: string }>;
    }>();

    for (const trace of input.traces) {
        const key = implementationKey(trace);
        if (!key) continue;
        const claim = claims.get(trace.claimId);
        const kinds = new Set<CompilerResourceKind>([
            ...operationKinds(trace.operation),
            ...claimKinds(claim),
        ]);
        if (kinds.size === 0) kinds.add('unknown');
        const group = groups.get(key) ?? {
            implementation: key,
            ...(trace.implementation.version ? { version: trace.implementation.version } : {}),
            kinds: new Set<CompilerResourceKind>(),
            resources: new Set<string>(),
            roles: new Set<string>(),
            blockReferences: new Set<string>(),
            evidence: new Map<string, { path: string; sha256: string }>(),
        };
        kinds.forEach(kind => group.kinds.add(kind));
        if (claim) {
            group.resources.add(claim.resource);
            group.roles.add(claim.role);
        }
        group.blockReferences.add(trace.blockId);
        for (const evidence of trace.apiEvidence) {
            group.evidence.set(`${evidence.path}|${evidence.sha256}`, evidence);
        }
        groups.set(key, group);
    }

    const gaps = unique(input.gaps ?? []);
    return [...groups.values()]
        .map(group => {
            const kinds = [...group.kinds].sort();
            const unresolved = unresolvedForKinds(kinds, gaps);
            return {
                implementation: group.implementation,
                ...(group.version ? { version: group.version } : {}),
                kinds,
                resources: [...group.resources].sort(),
                roles: [...group.roles].sort(),
                blockReferences: [...group.blockReferences].sort(),
                evidence: [...group.evidence.values()].sort((a, b) => a.path.localeCompare(b.path)),
                status: unresolved.length > 0 ? 'partial' as const : 'observed' as const,
                unresolved,
            };
        })
        .sort((a, b) => a.implementation.localeCompare(b.implementation));
}

export default summarizeCompilerLibraryResourceUsage;
