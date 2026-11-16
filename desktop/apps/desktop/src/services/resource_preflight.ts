/**
 * Read-only resource preflight orchestration.
 *
 * This module does not inspect generated C++ and does not resolve boards.  It
 * either projects an already completed ResourceAnalysis, or re-runs the
 * existing production claim adapter with the last compiler-resolved identity
 * and the live Blockly workspace.  The result is presentation state only: it
 * is never persisted, fed back into compilation, or used to allocate a
 * resource.
 */
import type {
    ResourceAnalysis,
} from './hardware_resource_graph';
import {
    buildHardwareResourceInspector,
    type HardwareResourceInspectorView,
    type InspectorBindingTrace,
    type InspectorCoverageView,
    type InspectorEvidenceTrace,
    type InspectorResourceTrace,
} from './hardware_resource_inspector';
import { analyzeProductionResolvedResources, type ProductionResourceContext } from './production_resource_analysis';
import type { ResourceBlock } from './resource_claim_binding';
import type { CompilerLibraryResourceUsage } from './compiler_resource_usage';

export type ResourcePreflightPhase = 'edit' | 'compile' | 'observation';
export type ResourcePreflightSeverity = 'pass' | 'warning' | 'conflict';
export type ResourcePreflightStatus = ResourcePreflightSeverity | 'unavailable';
export type ResourcePreflightEvidence = InspectorEvidenceTrace;
/** Presentation lifecycle only; never a resource, build or package identity. */
export type ImplementationCheckStatus = 'needs-compile' | 'running' | 'partial' | 'unavailable' | 'stale';

export interface ResourcePreflightIssue {
    /** Stable presentation record identity; never a build/schema identity. */
    id: string;
    severity: Exclude<ResourcePreflightSeverity, 'pass'>;
    code: string;
    resource?: string;
    claimIds: string[];
    /** Human-readable claim references, kept separate from stable claim IDs. */
    claimReferences: string[];
    blockReferences: string[];
    /** Observed implementation entry points; display only, not block identity. */
    sourceLabels?: Record<string, string>;
    bindings: InspectorBindingTrace[];
    evidence: InspectorEvidenceTrace[];
    coverage: InspectorCoverageView;
    /** UI resolves reason/impact/suggestion from this code using i18n. */
    explanationCode: string;
    canLocate: boolean;
}

export interface ResourcePreflightCheck {
    id: string;
    status: ResourcePreflightSeverity;
    severity: ResourcePreflightSeverity;
    code: string;
    resource?: string;
    /** Compatibility alias used by generic presentation consumers. */
    resourceId?: string;
    claimIds: string[];
    /** Human-readable claim references, kept separate from stable claim IDs. */
    claimReferences: string[];
    blockReferences: string[];
    sourceLabels?: Record<string, string>;
    bindings: InspectorBindingTrace[];
    evidence: InspectorEvidenceTrace[];
    coverage: InspectorCoverageView;
    issueId?: string;
}

export interface ResourcePreflightReport {
    phase: ResourcePreflightPhase;
    status: ResourcePreflightStatus;
    available: boolean;
    checkedAt: string;
    coverage: InspectorCoverageView | null;
    checks: ResourcePreflightCheck[];
    issues: ResourcePreflightIssue[];
    /** Why a report is unavailable, if no resolved production snapshot exists. */
    reasonCode?: string;
    /** Separate from declared-claim checks and physical hardware validation. */
    implementationCheck?: ImplementationCheckStatus;
    /** Always resource-analysis when available; no second parser is used. */
    source: 'resource-analysis' | 'none';
    /**
     * Read-only summaries emitted by the post-build compiler observer.
     * These are source-backed observations, not package metadata, claims or
     * hardware-validation results.
     */
    implementationUsage?: CompilerLibraryResourceUsage[];
}

export interface ResourcePreflightProjectionInput {
    phase: ResourcePreflightPhase;
    analysis?: ResourceAnalysis | null;
    inspector?: HardwareResourceInspectorView | null;
    checkedAt?: string;
}

export interface ResourcePreflightWorkspace {
    getAllBlocks(ordered: boolean): ResourceBlock[];
}

export interface ResourcePreflightRunInput {
    phase: ResourcePreflightPhase;
    /** The exact object returned by the completed production compile. */
    resolvedIdentity?: unknown;
    workspace?: ResourcePreflightWorkspace | null;
    /** Explicit validated third-party package graph/catalog, if selected. */
    boardResourceGraph?: ProductionResourceContext['boardResourceGraph'];
    catalog?: ProductionResourceContext['catalog'];
    checkedAt?: string;
}

export interface ResourcePreflightEvaluation {
    report: ResourcePreflightReport;
    inspector: HardwareResourceInspectorView | null;
    analysis: ResourceAnalysis | null;
}

const nowIso = (): string => new Date().toISOString();

const cloneBindings = (bindings: InspectorBindingTrace[]): InspectorBindingTrace[] => bindings.map(binding => ({
    ...binding,
    ancestors: [...binding.ancestors],
    claim: {
        ...binding.claim,
        configuration: { ...binding.claim.configuration },
        signals: { ...binding.claim.signals },
    },
}));

const cloneEvidence = (evidence: InspectorEvidenceTrace[]): InspectorEvidenceTrace[] => evidence.map(item => ({ ...item }));

const cloneCoverage = (coverage: InspectorCoverageView): InspectorCoverageView => ({
    ...coverage,
    evidence: { ...coverage.evidence },
});

const unique = (values: readonly string[]): string[] => [...new Set(values.filter(Boolean))];

const issueId = (severity: string, code: string, resource: string | undefined, claims: readonly string[]): string =>
    `resource-preflight:${severity}:${code}:${resource || 'project'}:${[...claims].sort().join(',')}`;

const hasPartialCoverage = (coverage: InspectorCoverageView): boolean => (
    [coverage.graph, coverage.analysis, coverage.declaration, coverage.project]
        .some(value => value === 'partial' || value === 'unknown')
);

function unavailableReport(
    phase: ResourcePreflightPhase,
    reasonCode: string,
    checkedAt = nowIso(),
): ResourcePreflightReport {
    return {
        phase,
        status: 'unavailable',
        available: false,
        checkedAt,
        coverage: null,
        checks: [],
        issues: [],
        reasonCode,
        source: 'none',
    };
}

function makeIssue(
    severity: Exclude<ResourcePreflightSeverity, 'pass'>,
    code: string,
    resource: string | undefined,
    claimIds: string[],
    blockReferences: string[],
    bindings: InspectorBindingTrace[],
    evidence: InspectorEvidenceTrace[],
    coverage: InspectorCoverageView,
): ResourcePreflightIssue {
    const clonedBindings = cloneBindings(bindings);
    return {
        id: issueId(severity, code, resource, claimIds),
        severity,
        code,
        ...(resource ? { resource } : {}),
        claimIds: unique(claimIds),
        claimReferences: unique(clonedBindings.map(binding => binding.claim.reference)),
        blockReferences: unique(blockReferences),
        bindings: clonedBindings,
        evidence: cloneEvidence(evidence),
        coverage: cloneCoverage(coverage),
        explanationCode: code,
        canLocate: blockReferences.length > 0,
    };
}

function checkFromIssue(issue: ResourcePreflightIssue): ResourcePreflightCheck {
    return {
        id: issue.id,
        status: issue.severity,
        severity: issue.severity,
        code: issue.code,
        ...(issue.resource ? { resource: issue.resource } : {}),
        ...(issue.resource ? { resourceId: issue.resource } : {}),
        claimIds: [...issue.claimIds],
        claimReferences: [...issue.claimReferences],
        blockReferences: [...issue.blockReferences],
        bindings: cloneBindings(issue.bindings),
        evidence: cloneEvidence(issue.evidence),
        coverage: cloneCoverage(issue.coverage),
        issueId: issue.id,
    };
}

function passCheck(
    code: string,
    resource: string | undefined,
    coverage: InspectorCoverageView,
    bindings: InspectorBindingTrace[] = [],
    evidence: InspectorEvidenceTrace[] = [],
    claimIds: string[] = [],
    blockReferences: string[] = [],
): ResourcePreflightCheck {
    return {
        id: `resource-preflight:pass:${code}:${resource || 'project'}`,
        status: 'pass',
        severity: 'pass',
        code,
        ...(resource ? { resource } : {}),
        ...(resource ? { resourceId: resource } : {}),
        claimIds: unique(claimIds),
        claimReferences: unique(bindings.map(binding => binding.claim.reference)),
        blockReferences: unique(blockReferences),
        bindings: cloneBindings(bindings),
        evidence: cloneEvidence(evidence),
        coverage: cloneCoverage(coverage),
    };
}

/**
 * Projects existing inspector records into active preflight checks.  No new
 * conflict is inferred here: conflicts and gaps are copied from the accepted
 * ResourceAnalysis/claim adapter output only.
 */
export function buildResourcePreflight(input: ResourcePreflightProjectionInput): ResourcePreflightReport {
    const checkedAt = input.checkedAt || nowIso();
    const inspector = input.inspector;
    const analysis = input.analysis;
    if (!inspector || !analysis) return unavailableReport(input.phase, 'resource-analysis-unavailable', checkedAt);

    const coverage = cloneCoverage(inspector.coverage);
    const issues: ResourcePreflightIssue[] = [];
    const checks: ResourcePreflightCheck[] = [];

    // Every analyzer conflict is surfaced with its existing trace path.
    for (const trace of inspector.conflictTraces) {
        const issue = makeIssue(
            'conflict',
            trace.conflict.code,
            trace.resourceId,
            trace.conflict.claims,
            trace.blockReferences,
            trace.bindings,
            trace.evidence,
            coverage,
        );
        issues.push(issue);
        checks.push(checkFromIssue(issue));
    }

    // Claim-adapter gaps are warnings.  They remain warnings even when they
    // concern a resource also mentioned by a conflict; the conflict itself is
    // still the authoritative blocker.
    for (const gap of inspector.gaps) {
        const trace: InspectorResourceTrace | undefined = gap.resource
            ? inspector.resourceTraces.find(item => item.resourceId === gap.resource)
            : undefined;
        const claimIds = gap.claim ? [gap.claim] : (trace?.claims.map(claim => claim.id) ?? []);
        const blockReferences = trace?.blockReferences ?? [];
        const bindings = trace?.bindings ?? [];
        const evidence = trace?.evidence ?? [];
        const issue = makeIssue('warning', gap.code, gap.resource, claimIds, blockReferences, bindings, evidence, coverage);
        if (issues.some(existing => existing.id === issue.id)) continue;
        issues.push(issue);
        checks.push(checkFromIssue(issue));
    }

    // Shared buses are an explicit positive check when the graph/analysis says
    // there is no conflict.  This avoids presenting multiple legal devices as
    // duplicate-use errors.
    for (const bus of inspector.buses) {
        if (bus.devices.length < 2 || bus.conflicts.length > 0) continue;
        const trace = inspector.resourceTraces.find(item => item.resourceId === bus.id);
        checks.push(passCheck(
            bus.sharing === 'address' ? 'shared-bus-addresses' : 'shared-bus',
            bus.id,
            coverage,
            trace?.bindings ?? [],
            trace?.evidence ?? [],
            trace?.claims.map(claim => claim.id) ?? [],
            trace?.blockReferences ?? [],
        ));
    }

    if (issues.length === 0 && !hasPartialCoverage(coverage)) {
        checks.push(passCheck('resource-analysis-complete', undefined, coverage));
    } else if (issues.length === 0 && hasPartialCoverage(coverage)) {
        // Partial/unknown coverage must never be represented as a safe pass.
        const issue = makeIssue('warning', 'coverage-partial', undefined, [], [], [], [], coverage);
        issues.push(issue);
        checks.push(checkFromIssue(issue));
    }

    const status: ResourcePreflightStatus = issues.some(issue => issue.severity === 'conflict')
        ? 'conflict'
        : issues.length > 0
            ? 'warning'
            : 'pass';
    return {
        phase: input.phase,
        status,
        available: true,
        checkedAt,
        coverage,
        checks,
        issues,
        source: 'resource-analysis',
    };
}

function inspectorInputFromProductionResult(value: unknown): {
    analysis: ResourceAnalysis;
    inspector: HardwareResourceInspectorView;
} | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const candidate = value as {
        status?: unknown;
        model?: { resource_graph?: unknown };
        report?: unknown;
        claims?: unknown;
        gaps?: unknown;
        coverage?: unknown;
    };
    if (candidate.status !== 'ready') return null;
    const graph = candidate.model?.resource_graph;
    const report = candidate.report;
    if (!graph || typeof graph !== 'object' || Array.isArray(graph)
        || !report || typeof report !== 'object' || Array.isArray(report)) return null;
    try {
        const analysis = report as ResourceAnalysis;
        const coverage = candidate.coverage && typeof candidate.coverage === 'object' && !Array.isArray(candidate.coverage)
            ? candidate.coverage as Parameters<typeof buildHardwareResourceInspector>[0]['coverage']
            : undefined;
        const inspector = buildHardwareResourceInspector({
            graph: graph as Parameters<typeof buildHardwareResourceInspector>[0]['graph'],
            analysis,
            claims: Array.isArray(candidate.claims) ? candidate.claims as Parameters<typeof buildHardwareResourceInspector>[0]['claims'] : undefined,
            gaps: Array.isArray(candidate.gaps) ? candidate.gaps as Parameters<typeof buildHardwareResourceInspector>[0]['gaps'] : undefined,
            coverage,
        });
        return { analysis, inspector };
    } catch {
        return null;
    }
}

/**
 * Runs the existing production resource adapter against the last exact
 * compiler-resolved identity. It intentionally refuses to guess a board or
 * parse generated source when either input is unavailable. The inspector and
 * analysis are returned alongside the report so the live Inspector and the
 * preflight panel can consume one identical evaluation.
 */
export function evaluateResourcePreflight(input: ResourcePreflightRunInput): ResourcePreflightEvaluation {
    const checkedAt = input.checkedAt || nowIso();
    if (!input.resolvedIdentity) {
        return {
            report: unavailableReport(input.phase, 'missing-resolved-identity', checkedAt),
            inspector: null,
            analysis: null,
        };
    }
    if (!input.workspace) {
        return {
            report: unavailableReport(input.phase, 'workspace-unavailable', checkedAt),
            inspector: null,
            analysis: null,
        };
    }
    const result = analyzeProductionResolvedResources(input.resolvedIdentity, input.workspace, {
        boardResourceGraph: input.boardResourceGraph,
        catalog: input.catalog,
    });
    const projected = inspectorInputFromProductionResult(result);
    if (!projected) {
        const reason = result && typeof result === 'object' && 'reason' in result
            ? String((result as { reason?: unknown }).reason || 'resource-analysis-unavailable')
            : 'resource-analysis-unavailable';
        return {
            report: unavailableReport(input.phase, reason, checkedAt),
            inspector: null,
            analysis: null,
        };
    }
    return {
        report: buildResourcePreflight({
            phase: input.phase,
            analysis: projected.analysis,
            inspector: projected.inspector,
            checkedAt,
        }),
        inspector: projected.inspector,
        analysis: projected.analysis,
    };
}

export function runResourcePreflight(input: ResourcePreflightRunInput): ResourcePreflightReport {
    return evaluateResourcePreflight(input).report;
}

export default buildResourcePreflight;
