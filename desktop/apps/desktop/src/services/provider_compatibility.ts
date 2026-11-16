import type { BlockPackageCompatibility } from '../types/library';
import type { ResourceAnalysis } from './hardware_resource_graph';
import type {
    ProviderBoardContext,
    ProviderCandidate,
    ResolvedProviderResult,
} from './provider_resolution';

export type CompatibilityStatus = 'Supported' | 'Unsupported' | 'Partial' | 'Unknown';
export type CompatibilityResourceImpact = 'None' | 'Warning' | 'Conflict' | 'Unknown';

export interface ProviderCompatibilityInput {
    provider: ResolvedProviderResult;
    boardContext?: ProviderBoardContext;
    resourceAnalysis?: ResourceAnalysis | null;
}

export interface ProviderCompatibilityResult {
    status: CompatibilityStatus;
    providerStatus: ResolvedProviderResult['status'];
    resourceImpact: CompatibilityResourceImpact;
    selectedCandidateRef?: string;
    reasonCodes: string[];
    unmetConditions: string[];
    evidenceRefs: string[];
}

const hasText = (value: unknown): value is string =>
    typeof value === 'string' && value.trim().length > 0;

const completeContext = (context: ProviderBoardContext | undefined): boolean => !!context
    && [context.fqbn, context.mcu, context.variant, context.coreVersion, context.fCpu].every(hasText)
    && !!context.options
    && !Array.isArray(context.options)
    && Object.values(context.options).every(value => typeof value === 'string');

const sameContext = (left: ProviderBoardContext | undefined, right: ProviderBoardContext | undefined): boolean => (
    completeContext(left) && completeContext(right)
    && ['fqbn', 'mcu', 'variant', 'coreVersion', 'fCpu'].every(key =>
        left![key as keyof ProviderBoardContext] === right![key as keyof ProviderBoardContext])
    && Object.keys(left!.options!).length === Object.keys(right!.options!).length
    && Object.entries(left!.options!).every(([key, value]) => right!.options![key] === value)
);

const contextSelectors = (context: ProviderBoardContext) => {
    const parts = context.fqbn.trim().toLowerCase().split(':');
    const coreId = parts.length >= 2 ? parts.slice(0, 2).join(':') : '';
    const boardId = parts.length >= 3 ? parts[2].split(',')[0] : '';
    return {
        board: [context.fqbn.toLowerCase(), parts.slice(0, 3).join(':'), boardId, coreId].filter(Boolean),
        architecture: [parts[1] || '', coreId].filter(Boolean),
    };
};

function selectorsMatch(
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

function supportMismatch(
    support: BlockPackageCompatibility | undefined,
    context: ProviderBoardContext,
): boolean {
    if (!support) return false;
    const selectors = contextSelectors(context);
    return selectorsMatch(support.boards, selectors.board) === 'mismatch'
        || selectorsMatch(support.architectures, selectors.architecture) === 'mismatch';
}

function selectedCandidate(provider: ResolvedProviderResult): ProviderCandidate | undefined {
    if (!provider.selectedCandidateRef) return undefined;
    return provider.candidates.find(candidate => candidate.ref === provider.selectedCandidateRef);
}

function resourceImpact(analysis: ResourceAnalysis | null | undefined): {
    impact: CompatibilityResourceImpact;
    reasons: string[];
} {
    if (!analysis) return { impact: 'Unknown', reasons: ['resource.analysis.missing'] };
    if (analysis.conflicts.length) return { impact: 'Conflict', reasons: ['resource.conflict'] };
    if (analysis.coverage !== 'full' || analysis.gaps.length) {
        return { impact: 'Warning', reasons: ['resource.coverage.partial'] };
    }
    return { impact: 'None', reasons: [] };
}

/**
 * Evaluates compatibility over a Resolved Provider result. It never selects a
 * provider, allocates a resource or re-parses generated C++; callers must
 * first use existing observations or the bounded unique-candidate gate.
 */
export function evaluateProviderCompatibility(
    input: ProviderCompatibilityInput,
): ProviderCompatibilityResult {
    const reasons = new Set<string>();
    const unmet = new Set<string>();
    const evidence = new Set(input.provider.evidenceRefs.filter(hasText));
    const impact = resourceImpact(input.resourceAnalysis);
    impact.reasons.forEach(reason => reasons.add(reason));
    if (input.provider.claims.observation) {
        input.provider.claims.observation.evidenceRefs.filter(hasText).forEach(ref => evidence.add(ref));
    }

    if (!input.boardContext || !completeContext(input.boardContext)) {
        return {
            status: 'Unknown',
            providerStatus: input.provider.status,
            resourceImpact: impact.impact,
            ...(input.provider.selectedCandidateRef ? { selectedCandidateRef: input.provider.selectedCandidateRef } : {}),
            reasonCodes: ['board.context.incomplete', ...reasons].sort(),
            unmetConditions: ['exact-board-context'],
            evidenceRefs: [...evidence].sort(),
        };
    }

    if (input.provider.boardContext && !sameContext(input.provider.boardContext, input.boardContext)) {
        reasons.add('provider.context.stale');
        unmet.add('provider-context-matches-current-target');
    }
    if (input.provider.status === 'Conflict') {
        reasons.add('provider.conflict');
        unmet.add('single-consistent-provider');
    }
    if (input.provider.status === 'Partial' || input.provider.unresolved.length) {
        for (const unresolved of input.provider.unresolved) {
            reasons.add(unresolved);
            unmet.add(unresolved);
        }
    }

    const candidate = selectedCandidate(input.provider);
    const allCandidates = input.provider.candidates;
    const explicitlyUnsupported = allCandidates.length > 0
        && allCandidates.every(item => supportMismatch(item.declaredSupport, input.boardContext!));
    if (explicitlyUnsupported) {
        reasons.add('declared-support.mismatch');
        unmet.add('declared-board-or-architecture-support');
    }
    if (candidate) {
        if (supportMismatch(candidate.declaredSupport, input.boardContext)) {
            reasons.add('declared-support.mismatch');
            unmet.add('declared-board-or-architecture-support');
        }
        for (const implementation of candidate.implementation) {
            if (implementation.boardContext && !sameContext(implementation.boardContext, input.boardContext)) {
                reasons.add('implementation.target.mismatch');
                unmet.add('implementation-target-matches-current-board');
            }
        }
    }

    let status: CompatibilityStatus;
    if (reasons.has('provider.context.stale')) status = 'Unknown';
    else if (explicitlyUnsupported || reasons.has('implementation.target.mismatch')) status = 'Unsupported';
    else if (input.provider.status === 'Conflict' || !candidate) status = 'Unknown';
    else if (input.provider.status === 'Unknown') status = 'Unknown';
    else if (input.provider.status === 'Partial' || input.provider.unresolved.length) status = 'Partial';
    else status = 'Supported';
    if (status === 'Supported' && impact.impact === 'Unknown') {
        status = 'Partial';
        unmet.add('resource-analysis-available');
    }

    return {
        status,
        providerStatus: input.provider.status,
        resourceImpact: impact.impact,
        ...(input.provider.selectedCandidateRef ? { selectedCandidateRef: input.provider.selectedCandidateRef } : {}),
        reasonCodes: [...reasons].sort(),
        unmetConditions: [...unmet].sort(),
        evidenceRefs: [...evidence].sort(),
    };
}

export default evaluateProviderCompatibility;
