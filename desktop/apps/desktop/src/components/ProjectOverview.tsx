import { ChevronRight, CircleAlert, CircleCheck, CircleHelp, Cpu, Loader2, Network } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { CompileDoctorReport } from '../services/compile_doctor';
import type { CompileIssueCard } from '../services/compile_issue_cards';
import type { ResourcePreflightReport } from '../services/resource_preflight';
import { resourceOverviewState } from './resource_presentation';

interface ProjectOverviewProps {
    projectName: string;
    boardName: string;
    dirty?: boolean;
    isCompiling?: boolean;
    compileReport: CompileDoctorReport | null;
    resourceReport: ResourcePreflightReport | null;
    resourceRunning?: boolean;
    issues: CompileIssueCard[];
    onOpenHealth?: () => void;
    historical?: boolean;
    needsRecheck?: boolean;
    showIdentity?: boolean;
    showStatus?: boolean;
    embedded?: boolean;
}

export function ProjectOverview({
    projectName, boardName, dirty = false, isCompiling = false, compileReport,
    resourceReport, resourceRunning = false, issues, onOpenHealth, historical = false, needsRecheck = false,
    showIdentity = true, showStatus = true, embedded = false,
}: ProjectOverviewProps) {
    const { t } = useTranslation('health');
    const { t: buildT } = useTranslation('build');
    const buildState = isCompiling ? 'running' : !compileReport ? 'unknown' : compileReport.success ? 'passed' : 'failed';
    const dependencyState = issues.some(item => item.id === 'missing-header') ? 'dependencyMissing'
        : compileReport?.success ? 'dependencyResolved' : 'unverified';
    const resourceState = resourceRunning ? 'running' : resourceOverviewState(resourceReport);
    const issue = issues.find(item => item.severity === 'error') || issues.find(item => item.severity === 'warning');
    const buildIssueCount = issues.filter(item => item.severity === 'error' || item.severity === 'warning').length;
    const resourceIssue = resourceReport?.issues.find(item => item.severity === 'conflict') || resourceReport?.issues[0];
    const BuildIcon = isCompiling ? Loader2 : buildState === 'passed' ? CircleCheck : buildState === 'failed' ? CircleAlert : CircleHelp;
    const resourceNeedsAttention = resourceState === 'conflict' || resourceState === 'warning' || resourceState === 'partial';
    const showResourceIssue = resourceIssue && (!issue || resourceIssue.severity === 'conflict' || issue.severity !== 'error');
    const issueLabel = showResourceIssue
        ? `${resourceIssue.resource ? `${resourceIssue.resource} · ` : ''}${t(`resourcePreflight.code.${resourceIssue.code}`, { defaultValue: t(`resourceInspector.conflictCode.${resourceIssue.code}`, { defaultValue: t('experience.reviewResource') }) })}`
        : issue
            ? buildT(`explanation.${issue.explanationCode}.title`, { ...issue.explanationParams, defaultValue: issue.title })
            : '';

    const resourceStatus = (
        <>
            <Network size={14} className={`shrink-0 ${resourceState === 'conflict' ? 'text-red-600 dark:text-red-300' : resourceNeedsAttention ? 'text-amber-600 dark:text-amber-300' : resourceState === 'pass' ? 'text-emerald-600 dark:text-emerald-300' : 'text-slate-400'}`} aria-hidden="true" />
            <span className="min-w-0 break-words">{t(`experience.resources.${resourceState}`)} · {t('productV2.check')}</span>
            {resourceReport?.available && <span className="shrink-0 text-[11px] text-slate-500 dark:text-slate-400">{t('experience.resourceIssueCount', { count: resourceReport.issues.length })}</span>}
        </>
    );

    return (
        <section data-ck-role="project-overview" aria-label={t('experience.projectStatus')}
            className={`${embedded ? 'border-b border-slate-200 px-3 py-2 dark:border-slate-800' : 'shrink-0 border-b border-slate-200 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-900'} text-xs text-slate-700 dark:text-slate-200`}>
            <div className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-2">
                {showIdentity && <div className="min-w-0 flex-1 basis-44">
                    <h2 className="truncate text-xs font-semibold" title={projectName || t('experience.untitled')}>
                        {projectName || t('experience.untitled')}
                        {dirty && <span className="ml-1 text-amber-600 dark:text-amber-300" aria-label={t('experience.unsaved')}>*</span>}
                    </h2>
                    <div className="mt-0.5 flex min-w-0 items-center gap-1 text-[11px] text-slate-500 dark:text-slate-400">
                        <Cpu size={12} className="shrink-0" aria-hidden="true" />
                        <span className="truncate" title={boardName}>{boardName || t('experience.boardUnknown')}</span>
                    </div>
                </div>}
                {showStatus && <>
                    <div data-ck-role="project-build-status" data-status={buildState}
                        className={`flex min-w-0 items-center gap-1.5 ${buildState === 'failed' ? 'text-red-700 dark:text-red-300' : buildState === 'passed' ? 'text-emerald-700 dark:text-emerald-300' : 'text-slate-500 dark:text-slate-400'}`}>
                        <BuildIcon size={14} className={isCompiling ? 'animate-spin shrink-0' : 'shrink-0'} aria-hidden="true" />
                        <span>{historical && compileReport ? `${t('productV2.lastBuild')}: ` : ''}{t(`experience.build.${buildState}`)}</span>
                        {buildIssueCount > 0 && <span className="text-[11px]">{t('experience.buildIssueCount', { count: buildIssueCount })}</span>}
                    </div>
                    <div className="text-[11px] text-slate-500 dark:text-slate-400" data-ck-role="project-dependencies">
                        {t('experience.libraries')}: {t(`experience.${dependencyState}`)}
                    </div>
                    {onOpenHealth ? (
                        <button type="button" onClick={onOpenHealth} data-ck-role="project-resource-status" data-status={resourceState}
                            className="flex min-w-0 max-w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-500 dark:hover:bg-slate-800"
                            title={t('experience.openHealth')}>
                            {resourceStatus}
                            <ChevronRight size={14} className="shrink-0" aria-hidden="true" />
                        </button>
                    ) : (
                        <div data-ck-role="project-resource-status" data-status={resourceState}
                            className="flex min-w-0 max-w-full items-center gap-2 rounded px-2 py-1 text-left">
                            {resourceStatus}
                        </div>
                    )}
                </>}
            </div>
            {(dirty || needsRecheck) && <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-300">{t('productV2.changedHint')}</p>}
            {showStatus && issueLabel && onOpenHealth && (
                <button type="button" onClick={onOpenHealth} data-ck-role="project-recent-issue"
                    className={`mt-1.5 flex w-full min-w-0 items-center gap-1.5 text-left text-[11px] hover:underline ${showResourceIssue ? resourceIssue.severity === 'conflict' ? 'text-red-700 dark:text-red-300' : 'text-amber-700 dark:text-amber-300' : issue?.severity === 'error' ? 'text-red-700 dark:text-red-300' : 'text-amber-700 dark:text-amber-300'}`}>
                    <CircleAlert size={12} className="shrink-0" aria-hidden="true" />
                    <span className="shrink-0">{t('experience.latestIssue')}:</span>
                    <span className="truncate" title={issueLabel}>{issueLabel}</span>
                </button>
            )}
        </section>
    );
}
