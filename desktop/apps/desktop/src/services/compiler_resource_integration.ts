/** Ephemeral compiler observation -> the existing Inspector and Preflight.
 * Nothing here writes workspace, package, build or board state.
 */
import { sha256Hex, type CompileSourceMapV1 } from './compile_source_map';
import { verifiedCompilerApis, type CapturedCompilerSnapshot } from './compiler_api_evidence';
import { observeCompilerResources, type CompilerTimingObservation, type CompilerResourceObservationInput } from './compiler_resource_observation';
import { summarizeCompilerLibraryResourceUsage } from './compiler_resource_usage';
import { analyzeHardwareResources, type BoardResourceGraph, type ResourceClaim } from './hardware_resource_graph';
import { buildHardwareResourceInspector } from './hardware_resource_inspector';
import { buildResourcePreflight, type ImplementationCheckStatus, type ResourcePreflightEvaluation, type ResourcePreflightIssue } from './resource_preflight';
import type { ProviderBoardContext } from './provider_resolution';

interface BaseAnalysis {
    status: 'ready';
    model: {
        identity: ProviderBoardContext;
        resource_graph: BoardResourceGraph;
        pwm?: Record<string, string>;
        adc?: Record<string, string>;
        coreDependencies?: { tone?: { resource: string } };
    };
    claims: ResourceClaim[];
    gaps: { block?: string; code: string; resource?: string }[];
    coverage: Parameters<typeof buildHardwareResourceInspector>[0]['coverage'];
}

/** Latency is a potential runtime interaction, not exclusive timer ownership.
 * Pair effects, never library names, block types or board names. */
export function interruptLatencyFindings(timing: readonly CompilerTimingObservation[]) {
    const sensitive = timing.filter(item => item.effect === 'interrupt-sensitive');
    const blocking = timing.filter(item => item.effect === 'interrupt-blocking');
    const pairs = new Map<string, { sensitive: CompilerTimingObservation; blocking: CompilerTimingObservation; blockReferences: string[] }>();
    for (const a of sensitive) for (const b of blocking) {
        if (a.blockId === b.blockId) continue;
        const key = JSON.stringify([a.implementation, b.implementation]);
        const previous = pairs.get(key);
        pairs.set(key, { sensitive: a, blocking: b,
            blockReferences: [...new Set([...(previous?.blockReferences ?? []), a.blockId, b.blockId])] });
    }
    return [...pairs.values()];
}

export function integrateCompilerResources(
    baseValue: unknown,
    capture: CapturedCompilerSnapshot,
    code: string,
    sourceMap: Readonly<CompileSourceMapV1>,
    trustedSource?: CompilerResourceObservationInput['trustedSource'],
): ResourcePreflightEvaluation | null {
    const base = baseValue as BaseAnalysis | null;
    if (base?.status !== 'ready' || !base.model?.resource_graph || !base.model.identity) return null;
    const graph = base.model.resource_graph;
    const proof = verifiedCompilerApis(capture);
    const observed = observeCompilerResources({
        snapshot: { ...capture, graphSha256: sha256Hex(JSON.stringify(graph)) },
        current: { context: base.model.identity, code, sources: capture.sources,
            compileCommandsSha256: capture.compileCommandsSha256 },
        sourceMap, graph, apiEvidence: proof.i2c, primitiveEvidence: proof.primitives,
        trustedSource,
        mappings: { pwm: base.model.pwm, adc: base.model.adc, tone: base.model.coreDependencies?.tone?.resource },
    });
    if (observed.status === 'Unknown') return null;
    // The same first-party operation can also have a declared claim. Do not
    // create a second owner just because two evidence paths observed it.
    const same = (a: ResourceClaim, b: ResourceClaim) => a.reference === b.reference && a.resource === b.resource
        && a.role === b.role && a.discriminator === b.discriminator
        && Object.keys({ ...a.configuration, ...b.configuration }).every(key =>
            String(a.configuration?.[key]) === String(b.configuration?.[key]));
    const claims = [...base.claims.map(item => structuredClone(item))];
    const observedClaimIds = new Map<string, string>();
    for (const claim of observed.claims) {
        const existing = claims.find(item => same(item, claim));
        if (existing) {
            observedClaimIds.set(claim.id, existing.id);
            continue;
        }
        const id = `observed:${claims.length}`;
        claims.push({ ...claim, id });
        observedClaimIds.set(claim.id, id);
    }
    // Partial always: recognizing a subset is not proof that an entire project
    // has complete declarations or has been tested on physical hardware.
    const analysis = analyzeHardwareResources(graph, claims, Math.max(1, base.gaps.length));
    const inspector = buildHardwareResourceInspector({
        graph, analysis, claims, gaps: base.gaps,
        coverage: { ...base.coverage, projectCoverage: 'partial', analysisCoverage: 'partial' },
    });
    const report = buildResourcePreflight({ phase: 'observation', inspector, analysis });
    report.implementationUsage = summarizeCompilerLibraryResourceUsage({
        traces: observed.traces.map(trace => ({
            ...trace,
            claimId: observedClaimIds.get(trace.claimId) ?? trace.claimId,
        })),
        claims,
        gaps: observed.gaps,
    });
    report.implementationCheck = 'partial';
    for (const { sensitive, blocking, blockReferences } of interruptLatencyFindings(observed.timing)) {
        const evidence = [...new Map([...sensitive.evidence, ...blocking.evidence].map(item => [item.path, item])).values()]
            .map(item => ({ id: `compiler:${item.sha256.slice(0, 16)}`, source: item.path,
                locator: `sha256:${item.sha256}`, confidence: 'verified' as const }));
        const issue: ResourcePreflightIssue = {
            id: `compiler-latency:${sha256Hex(JSON.stringify(blockReferences)).slice(0, 24)}`,
            severity: 'warning', code: 'interrupt-latency-risk', explanationCode: 'interrupt-latency-risk',
            blockReferences, claimIds: claims.filter(item => blockReferences.includes(item.reference)).map(item => item.id),
            claimReferences: [sensitive, blocking].map(item => item.steps[item.steps.length - 1]?.function || item.implementation),
            sourceLabels: Object.fromEntries(observed.timing.filter(item => blockReferences.includes(item.blockId))
                .map(item => [item.blockId, item.steps[item.steps.length - 1]?.function || item.implementation])),
            bindings: [], evidence, coverage: structuredClone(inspector.coverage), canLocate: true,
        };
        report.issues.push(issue);
        report.checks.unshift({ ...structuredClone(issue), status: 'warning', issueId: issue.id });
        if (report.status !== 'conflict') report.status = 'warning';
    }
    // Attach actual implementation evidence alongside board evidence on conflicts.
    for (const issue of report.issues) {
        const proofSources = observed.traces.filter(trace => issue.blockReferences.includes(trace.blockId)).flatMap(trace => trace.apiEvidence);
        for (const item of proofSources) if (!issue.evidence.some(existing => existing.source === item.path)) {
            issue.evidence.push({ id: `compiler:${item.sha256.slice(0, 16)}`, source: item.path,
                locator: `sha256:${item.sha256}`, confidence: 'verified' });
        }
        const check = report.checks.find(item => item.issueId === issue.id);
        if (check) check.evidence = structuredClone(issue.evidence);
    }
    const rank = { conflict: 0, warning: 1, pass: 2 };
    report.checks.sort((a, b) => rank[a.severity] - rank[b.severity]);
    return { report, inspector, analysis };
}

export interface CompilerResourcePresentationCache {
    workspaceJson: string;
    fqbn: string;
    codeSha256: string;
    evaluation: ResourcePreflightEvaluation;
}

/** One ephemeral attempt, invalidated by the same snapshot as its result. */
export interface CompilerObservationAttempt {
    workspaceJson: string;
    fqbn: string;
    codeSha256: string;
    status: ImplementationCheckStatus;
}
export function currentCompilerObservationStatus(
    attempt: CompilerObservationAttempt | null,
    workspaceJson: string, fqbn: string, code: string,
): ImplementationCheckStatus {
    if (!attempt) return 'needs-compile';
    return attempt.workspaceJson === workspaceJson && attempt.fqbn === fqbn && attempt.codeSha256 === sha256Hex(code)
        ? attempt.status : 'stale';
}
export function currentCompilerResourcePresentation(
    cache: CompilerResourcePresentationCache | null,
    workspaceJson: string, fqbn: string, code: string,
): ResourcePreflightEvaluation | null {
    return cache && cache.workspaceJson === workspaceJson && cache.fqbn === fqbn && cache.codeSha256 === sha256Hex(code)
        ? structuredClone(cache.evaluation) : null;
}

export function markCompilerObservationStale(evaluation: ResourcePreflightEvaluation): ResourcePreflightEvaluation {
    const next = structuredClone(evaluation);
    next.report.implementationCheck = 'stale';
    if (!next.report.coverage) return next;
    const issue: ResourcePreflightIssue = {
        id: 'compiler-observation:stale', code: 'compiler-observation-stale',
        explanationCode: 'compiler-observation-stale', severity: 'warning',
        claimIds: [], claimReferences: [], blockReferences: [], bindings: [], evidence: [],
        coverage: structuredClone(next.report.coverage), canLocate: false,
    };
    next.report.issues.unshift(issue);
    next.report.checks.unshift({ ...structuredClone(issue), status: 'warning', issueId: issue.id });
    if (next.report.status === 'pass') next.report.status = 'warning';
    return next;
}
