import type {
    ProjectAcceptanceReport,
    ProjectHealthCheck,
    ProjectHealthStage,
    ProjectHealthState,
} from './project_acceptance_report';

/**
 * Presentation-only descriptors for acceptance reports.
 *
 * The v1 report remains the canonical evidence payload. This sidecar is
 * intentionally derived from stable ids/state and is never serialized into
 * the report, exported package, or evidence hash.
 */
export interface AcceptanceReportPresentation {
    schemaVersion: 1;
    report: ProjectAcceptanceReport;
    healthSummary: {
        passed: number;
        warnings: number;
        errors: number;
        info: number;
    };
}

export const acceptanceCheckTitleKey = (check: Pick<ProjectHealthCheck, 'id'>): string => (
    `acceptance.checks.${check.id}`
);

export const acceptanceStageTitleKey = (stage: Pick<ProjectHealthStage, 'id'>): string => (
    `acceptance.stages.${stage.id}`
);

export const acceptanceResourceGrowthSummaryKey = (
    status: ProjectAcceptanceReport['build']['resourceGrowth']['status'],
): string => `resource.growth.summary.${status}`;

export const createAcceptanceReportPresentation = (
    report: ProjectAcceptanceReport,
): AcceptanceReportPresentation => ({
    schemaVersion: 1,
    report,
    healthSummary: {
        passed: report.health.counts.pass,
        warnings: report.health.counts.warning,
        errors: report.health.counts.error,
        info: report.health.counts.info,
    },
});

export const acceptanceStateIsAttention = (state: ProjectHealthState): boolean => (
    state === 'warning' || state === 'error'
);
