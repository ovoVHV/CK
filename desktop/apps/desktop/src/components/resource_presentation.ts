import type { InspectorCoverageView } from '../services/hardware_resource_inspector';
import type { ResourcePreflightReport } from '../services/resource_preflight';

// Display classification only. Never used as a compile gate or resource decision.
export function resourceCoverageState(coverage: InspectorCoverageView | null | undefined): 'full' | 'partial' | 'unknown' {
    if (!coverage) return 'unknown';
    const values = [coverage.graph, coverage.analysis, coverage.declaration, coverage.project];
    if (values.every(value => value === 'full')) return 'full';
    if (values.some(value => value === 'partial')) return 'partial';
    return 'unknown';
}

export function resourceOverviewState(report: ResourcePreflightReport | null | undefined) {
    if (!report?.available || report.status === 'unavailable') return 'unavailable';
    if (report.status === 'conflict') return 'conflict';
    if (report.status === 'warning') return 'warning';
    const coverage = resourceCoverageState(report.coverage);
    return coverage === 'full' ? 'pass' : coverage;
}

export type PresentationTranslate = (key: string, options?: Record<string, unknown>) => string;

export function resourceRoleLabel(role: string, t: PresentationTranslate): string {
    return t(`experience.roles.${role}`, { defaultValue: role });
}
