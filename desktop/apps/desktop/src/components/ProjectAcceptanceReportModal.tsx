import { useEffect, useMemo, useRef, useState } from 'react';
import { projectHealthCapabilities } from '../services/project_health_capabilities';
import {
    CheckCircle2,
    CircleAlert,
    CircleHelp,
    FileJson2,
    FileText,
    FolderInput,
    Loader2,
    PackageCheck,
    RefreshCw,
    ShieldCheck,
    X,
    XCircle,
} from 'lucide-react';
import { open as openFile, save } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '@tauri-apps/plugin-fs';
import { useTranslation } from 'react-i18next';
import {
    projectAcceptanceReportToHtml,
    type ProjectAcceptanceReport,
    type ProjectAcceptanceNotes,
    type ProjectHealthState,
} from '../services/project_acceptance_report';
import { formatResourceBytes } from '../services/compile_resources';
import {
    acceptanceCheckTitleKey,
    acceptanceStageTitleKey,
    createAcceptanceReportPresentation,
} from '../services/acceptance_report_presentation';
import {
    exportProjectSubmission,
    inspectProjectSubmission,
    type ProjectSubmissionInspection,
    type ProjectSubmissionSourceScope,
} from '../services/project_submission';

export type ProjectAcceptanceReportProvider = (notes?: ProjectAcceptanceNotes) => (
    ProjectAcceptanceReport | Promise<ProjectAcceptanceReport>
);

export interface ProjectSubmissionMaterial {
    workspaceJson: string;
    generatedSource: string;
    ckLock?: string | null;
}

export type ProjectSubmissionMaterialProvider = () => (
    ProjectSubmissionMaterial | Promise<ProjectSubmissionMaterial>
);

interface ProjectAcceptanceReportModalProps {
    isOpen: boolean;
    onClose: () => void;
    reportProvider: ProjectAcceptanceReportProvider;
    submissionMaterialProvider: ProjectSubmissionMaterialProvider;
    suggestedBaseName?: string;
    onExported?: (path: string, format: 'json' | 'html' | 'ckpkg') => void;
}

const stateStyle: Record<ProjectHealthState, {
    Icon: typeof CheckCircle2;
    className: string;
}> = {
    pass: { Icon: CheckCircle2, className: 'text-emerald-700 bg-emerald-50 border-emerald-200 dark:text-emerald-300 dark:bg-emerald-950/45 dark:border-emerald-900' },
    warning: { Icon: CircleAlert, className: 'text-amber-700 bg-amber-50 border-amber-200 dark:text-amber-300 dark:bg-amber-950/45 dark:border-amber-900' },
    error: { Icon: XCircle, className: 'text-red-700 bg-red-50 border-red-200 dark:text-red-300 dark:bg-red-950/45 dark:border-red-900' },
    info: { Icon: CircleHelp, className: 'text-slate-600 bg-slate-100 border-slate-200 dark:text-slate-300 dark:bg-slate-800 dark:border-slate-700' },
};

const safeBaseName = (value: string): string => {
    const normalized = value.trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/\s+/g, '-');
    return normalized || 'CK-project';
};

const stateLabelKey = (state: ProjectAcceptanceReport['build']['state']): string => {
    if (state === 'passed') return 'acceptance.build.passed';
    if (state === 'failed') return 'acceptance.build.failed';
    if (state === 'unverified-target') return 'acceptance.build.unverifiedTarget';
    return 'acceptance.build.notRun';
};

const submissionScopeLabelKey: Record<ProjectSubmissionSourceScope, string> = {
    no_source: 'acceptance.submission.scope.noSource',
    editable_project: 'acceptance.submission.scope.editableProject',
    generated_source: 'acceptance.submission.scope.generatedSource',
    editable_and_generated: 'acceptance.submission.scope.editableAndGenerated',
};

export function ProjectAcceptanceReportModal({
    isOpen,
    onClose,
    reportProvider,
    submissionMaterialProvider,
    suggestedBaseName = 'CK-project',
    onExported,
}: ProjectAcceptanceReportModalProps) {
    const { t: translate } = useTranslation('health');
    const t = translate as unknown as (key: string, options?: Record<string, unknown>) => string;
    const [report, setReport] = useState<ProjectAcceptanceReport | null>(null);
    const reportRequestRef = useRef(0);
    const loadedProviderRef = useRef<ProjectAcceptanceReportProvider | null>(null);
    const [busy, setBusy] = useState<'load' | 'json' | 'html' | 'ckpkg' | 'import' | null>(null);
    const exporting = busy !== null && busy !== 'load';
    const [error, setError] = useState('');
    const [circuitDescription, setCircuitDescription] = useState('');
    const [testRecords, setTestRecords] = useState('');
    const [sourceScope, setSourceScope] = useState<ProjectSubmissionSourceScope>('no_source');
    const [sourceDisclosureAcknowledged, setSourceDisclosureAcknowledged] = useState(false);
    const [includeLock, setIncludeLock] = useState(false);
    const [includeBuildEvidence, setIncludeBuildEvidence] = useState(true);
    const [importedSubmission, setImportedSubmission] = useState<ProjectSubmissionInspection | null>(null);
    const [exportedPackageIdentity, setExportedPackageIdentity] = useState<{
        fileName: string;
        sha256: string;
    } | null>(null);
    const presentation = useMemo(
        () => report ? createAcceptanceReportPresentation(report) : null,
        [report],
    );

    const load = async () => {
        const request = ++reportRequestRef.current;
        setBusy('load');
        setError('');
        setReport(null);
        try {
            const nextReport = await reportProvider({ circuitDescription, testRecords });
            if (request !== reportRequestRef.current) return;
            setReport(nextReport);
            if (!nextReport.dependencies.lockAvailable) setIncludeLock(false);
        } catch (cause) {
            if (request !== reportRequestRef.current) return;
            setReport(null);
            setError(t('acceptance.errors.load', { cause: String(cause) }));
        } finally {
            if (request === reportRequestRef.current) setBusy(null);
        }
    };

    useEffect(() => {
        if (!isOpen) return;
        // A previously inspected package must never look like the file selected
        // in a later modal session.
        setImportedSubmission(null);
        setExportedPackageIdentity(null);
    }, [isOpen]);

    useEffect(() => {
        if (!isOpen) {
            loadedProviderRef.current = null;
            return;
        }
        if (exporting || loadedProviderRef.current === reportProvider) return;
        loadedProviderRef.current = reportProvider;
        void load();
        return () => { ++reportRequestRef.current; };
        // Refresh on evidence/target changes; an older async load cannot replace
        // a newer target's report or reappear after the modal was closed.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen, reportProvider, exporting]);

    useEffect(() => {
        if (!isOpen) return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape' && busy === null) onClose();
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [isOpen, busy, onClose]);

    if (!isOpen) return null;

    const exportReport = async (format: 'json' | 'html') => {
        if (!report || busy) return;
        setBusy(format);
        setError('');
        try {
            const extension = format === 'json' ? 'json' : 'html';
            const freshReport = await reportProvider({ circuitDescription, testRecords });
            setReport(freshReport);
            const path = await save({
                title: format === 'json' ? t('acceptance.export.structuredTitle') : t('acceptance.export.printableTitle'),
                defaultPath: `${safeBaseName(suggestedBaseName)}-${t('acceptance.fileName')}.${extension}`,
                filters: [{
                    name: format === 'json' ? t('acceptance.export.jsonFilter') : t('acceptance.export.htmlFilter'),
                    extensions: [extension],
                }],
            });
            if (!path) return;
            const content = format === 'json'
                ? `${JSON.stringify(freshReport, null, 2)}\n`
                : projectAcceptanceReportToHtml(freshReport);
            await writeTextFile(path, content);
            onExported?.(path, format);
        } catch (cause) {
            setError(t('acceptance.errors.export', { cause: String(cause) }));
        } finally {
            setBusy(null);
        }
    };

    const exportSubmission = async () => {
        if (!report || busy) return;
        setBusy('ckpkg');
        setError('');
        try {
            if (sourceScope !== 'no_source' && !sourceDisclosureAcknowledged) {
                throw new Error(t('acceptance.errors.sourceDisclosureRequired'));
            }
            const [freshReport, material] = await Promise.all([
                reportProvider({ circuitDescription, testRecords }),
                submissionMaterialProvider(),
            ]);
            setReport(freshReport);
            if (includeLock && !material.ckLock) {
                throw new Error(t('acceptance.errors.lockUnavailable'));
            }
            const path = await save({
                title: t('acceptance.submission.exportTitle'),
                defaultPath: `${safeBaseName(suggestedBaseName)}.ckpkg`,
                filters: [{ name: t('acceptance.submission.packageFilter'), extensions: ['ckpkg'] }],
            });
            if (!path) return;
            const includesWorkspace = sourceScope === 'editable_project'
                || sourceScope === 'editable_and_generated';
            const includesGenerated = sourceScope === 'generated_source'
                || sourceScope === 'editable_and_generated';
            const result = await exportProjectSubmission({
                outputPath: path,
                sourceScope,
                sourceDisclosureAcknowledged,
                report: freshReport,
                ...(includesWorkspace ? { workspaceJson: material.workspaceJson } : {}),
                ...(includesGenerated ? { generatedSource: material.generatedSource } : {}),
                ...(includeLock && material.ckLock ? { ckLock: material.ckLock } : {}),
                includeBuildEvidence,
            });
            setExportedPackageIdentity({
                fileName: result.packageFileName,
                sha256: result.packageSha256,
            });
            onExported?.(result.outputPath, 'ckpkg');
        } catch (cause) {
            setError(t('acceptance.errors.submissionExport', { cause: String(cause) }));
        } finally {
            setBusy(null);
        }
    };

    const importSubmission = async () => {
        if (busy) return;
        setBusy('import');
        setError('');
        setImportedSubmission(null);
        try {
            const selected = await openFile({
                title: t('acceptance.import.title'),
                multiple: false,
                directory: false,
                filters: [{ name: t('acceptance.submission.packageFilter'), extensions: ['ckpkg'] }],
            });
            const path = Array.isArray(selected) ? selected[0] : selected;
            if (!path) return;
            setImportedSubmission(await inspectProjectSubmission(path));
        } catch (cause) {
            setImportedSubmission(null);
            setError(t('acceptance.errors.submissionInspect', { cause: String(cause) }));
        } finally {
            setBusy(null);
        }
    };

    return (
        <div className="fixed inset-0 z-[620] flex items-center justify-center bg-slate-950/45 p-4 backdrop-blur-[1px]" role="dialog" aria-modal="true" aria-label={t('acceptance.ariaLabel')}>
            <div className="flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-slate-50 shadow-2xl dark:border-slate-700 dark:bg-slate-950">
                <header className="flex shrink-0 items-center gap-3 border-b border-slate-200 bg-white px-5 py-3 dark:border-slate-700 dark:bg-slate-900">
                    <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-100 text-brand-700 dark:bg-brand-950/60 dark:text-brand-300"><ShieldCheck size={19} /></span>
                    <div className="min-w-0 flex-1">
                        <h2 className="text-sm font-bold text-slate-900 dark:text-slate-100">{t('acceptance.title')}</h2>
                        <p className="mt-0.5 text-[10px] text-slate-500 dark:text-slate-400">{t('acceptance.subtitle')}</p>
                    </div>
                    <button type="button" onClick={() => void load()} disabled={Boolean(busy)} className="flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-semibold text-slate-600 hover:bg-slate-100 disabled:opacity-50 dark:text-slate-300 dark:hover:bg-slate-800"><RefreshCw size={14} />{t('acceptance.refresh')}</button>
                    <button type="button" onClick={onClose} disabled={Boolean(busy)} className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-800 disabled:opacity-50 dark:hover:bg-slate-800 dark:hover:text-slate-100" aria-label={t('acceptance.closeAria')}><X size={17} /></button>
                </header>

                <main className="min-h-0 flex-1 overflow-y-auto p-4">
                    {busy === 'load' && !report && (
                        <div className="flex min-h-48 items-center justify-center gap-2 text-sm text-slate-500"><Loader2 size={18} className="animate-spin" />{t('acceptance.loading')}</div>
                    )}
                    {error && <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">{error}</div>}
                    <section className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900/75" aria-label={t('acceptance.submission.inspectSectionAria')}>
                        <div className="min-w-0">
                            <div className="text-xs font-bold text-slate-800 dark:text-slate-100">{t('acceptance.submission.inspectTitle')}</div>
                            <div className="mt-0.5 text-[9px] text-slate-500 dark:text-slate-400">{t('acceptance.submission.inspectDescription')}</div>
                        </div>
                        <button type="button" onClick={() => void importSubmission()} disabled={Boolean(busy)} className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 text-[10px] font-semibold text-slate-600 hover:bg-slate-100 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"><FolderInput size={13} />{busy === 'import' ? t('acceptance.submission.inspecting') : t('acceptance.submission.openReadOnly')}</button>
                    </section>
                    {exportedPackageIdentity && (
                        <section className="mb-3 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-[10px] leading-4 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/35 dark:text-emerald-200" aria-label={t('acceptance.submission.exportedAria')}>
                            <strong>{t('acceptance.submission.exportedTitle')}</strong><br />{t('acceptance.fileLabel')}：{exportedPackageIdentity.fileName}<br />{t('acceptance.shaLabel')}：<code className="break-all">{exportedPackageIdentity.sha256}</code>
                        </section>
                    )}
                    {importedSubmission && (
                        <section className="mb-4 rounded-xl border border-brand-200 bg-brand-50/80 p-3 dark:border-brand-900 dark:bg-brand-950/30" aria-label={t('acceptance.submission.summaryAria')}>
                            <div className="flex flex-wrap items-start justify-between gap-2">
                                <div>
                                    <div className="flex items-center gap-1.5 text-xs font-bold text-brand-800 dark:text-brand-200"><PackageCheck size={15} />{t('acceptance.submission.checkedTitle')}</div>
                                    <div className="mt-1 text-[9px] text-brand-700/80 dark:text-brand-300/80">{t('acceptance.submission.checkedDescription')}</div>
                                </div>
                                <button type="button" onClick={() => setImportedSubmission(null)} className="rounded px-2 py-1 text-[10px] font-semibold text-brand-700 hover:bg-brand-100 dark:text-brand-300 dark:hover:bg-brand-900/60">{t('acceptance.submission.closeSummary')}</button>
                            </div>
                            <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                                {[
                                    [t('acceptance.fields.project'), `${importedSubmission.summary.projectName} · ${t('acceptance.blockCount', { count: importedSubmission.summary.blockCount })}`],
                                    [t('acceptance.fields.boardCore'), `${importedSubmission.summary.boardName} · ${importedSubmission.summary.coreId}@${importedSubmission.summary.coreVersion || t('acceptance.unrecognized')}`],
                                    [t('acceptance.fields.compileResource'), `${t(stateLabelKey(importedSubmission.summary.compileState))} · Flash ${formatResourceBytes(importedSubmission.summary.flashUsedBytes ?? Number.NaN)} / ${formatResourceBytes(importedSubmission.summary.flashTotalBytes ?? Number.NaN)} · RAM ${formatResourceBytes(importedSubmission.summary.ramUsedBytes ?? Number.NaN)} / ${formatResourceBytes(importedSubmission.summary.ramTotalBytes ?? Number.NaN)}`],
                                    [t('acceptance.fields.dependencyDeviceCheckpoint'), `${importedSubmission.summary.dependencyCount} ${t('acceptance.itemsUnit')}（${importedSubmission.summary.dependenciesAllVersioned ? t('acceptance.versionComplete') : t('acceptance.versionIncomplete')}）· ${importedSubmission.summary.hardwareChip || importedSubmission.summary.hardwareState} · Flash ${formatResourceBytes(importedSubmission.summary.hardwareFlashBytes ?? Number.NaN)} · PSRAM ${formatResourceBytes(importedSubmission.summary.hardwarePsramBytes ?? Number.NaN)} · ${importedSubmission.summary.checkpointCount} ${t('acceptance.checkpointUnit')}`],
                                ].map(([label, value]) => (
                                    <div key={label} className="min-w-0 rounded-lg border border-brand-200/70 bg-white/80 p-2 dark:border-brand-900 dark:bg-slate-950/60">
                                        <div className="text-[8px] font-bold uppercase tracking-wide text-brand-600 dark:text-brand-400">{label}</div>
                                        <div className="mt-1 break-words text-[10px] font-semibold leading-4 text-slate-700 dark:text-slate-200">{value}</div>
                                    </div>
                                ))}
                            </div>
                            <div className="mt-2 break-all rounded-lg bg-white/70 px-2 py-1.5 text-[9px] leading-4 text-slate-600 dark:bg-slate-950/60 dark:text-slate-300">
                                {t('acceptance.fileLabel')}：{importedSubmission.packageFileName}<br />{t('acceptance.shaLabel')}：<code>{importedSubmission.packageSha256}</code><br />
                                {t('acceptance.submission.scopeLabel')}：{t(submissionScopeLabelKey[importedSubmission.sourceScope])} · {t('acceptance.submission.lockLabel')}：{importedSubmission.hasDependencyLock ? t('acceptance.yes') : t('acceptance.no')} · {t('acceptance.submission.evidenceLabel')}：{importedSubmission.hasBuildEvidence ? t('acceptance.yes') : t('acceptance.no')}<br />
                                FQBN：{importedSubmission.summary.fqbn}<br />{t('acceptance.healthLabel')}：{importedSubmission.summary.healthSummary}<br /><strong>{importedSubmission.authenticityMessage}</strong>
                            </div>
                        </section>
                    )}
                    {report && (
                        <div className="grid gap-4">
                            <section className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4" aria-label={t('acceptance.summaryAria')}>
                                {[
                                    [t('acceptance.fields.project'), `${report.project.name} · ${t('acceptance.blockCount', { count: report.project.blockCount })}`],
                                    [t('acceptance.fields.boardCore'), `${report.target.boardName} · ${report.target.coreId}@${report.target.coreVersion || t('acceptance.unrecognized')}`],
                                    [t('acceptance.fields.compile'), t(stateLabelKey(report.build.state))],
                                    ...(report.hardware.state !== 'unsupported' ? [[t('acceptance.fields.device'), report.hardware.state === 'verified' ? `${report.hardware.chip || t('acceptance.chip')} ${t('acceptance.verified')}` : `${t('acceptance.device')} ${report.hardware.state}`]] : []),
                                ].map(([label, value]) => (
                                    <div key={label} className="min-w-0 rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900/75">
                                        <div className="text-[9px] font-bold uppercase tracking-wide text-slate-400">{label}</div>
                                        <div className="mt-1 break-words text-xs font-bold leading-5 text-slate-800 dark:text-slate-100">{value}</div>
                                    </div>
                                ))}
                            </section>

                            <section className="rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900/75" aria-label={t('acceptance.healthChecksAria')}>
                                <div className="flex items-center justify-between gap-2">
                                    <h3 className="text-xs font-bold text-slate-800 dark:text-slate-100">{t('acceptance.healthChecksTitle')}</h3>
                                    <span className="text-[10px] text-slate-500 dark:text-slate-400">{presentation ? t('acceptance.healthSummary', presentation.healthSummary) : ''}</span>
                                </div>
                                <div className="mt-2 grid gap-2 md:grid-cols-2">
                                    {report.health.checks.map(check => {
                                        const theme = stateStyle[check.state];
                                        return (
                                            <div key={check.id} className={`flex min-w-0 items-start gap-2 rounded-lg border border-slate-100 bg-slate-50/80 p-2.5 dark:border-slate-800 dark:bg-slate-950/50 ${check.stages ? 'md:col-span-2' : ''}`}>
                                                <span className={`flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[9px] font-bold ${theme.className}`}><theme.Icon size={11} />{t(`acceptance.state.${check.state}`)}</span>
                                                <div className="min-w-0 flex-1">
                                                    <div className="text-[11px] font-bold text-slate-700 dark:text-slate-200">{t(acceptanceCheckTitleKey(check), { defaultValue: check.title })}</div>
                                                    <div className="mt-0.5 break-words text-[9px] leading-4 text-slate-500 dark:text-slate-400">{check.detail}</div>
                                                    {check.stages && (
                                                        <div className="mt-2 grid gap-1.5 sm:grid-cols-2 lg:grid-cols-4" aria-label={t('acceptance.passportStagesAria')}>
                                                            {check.stages.map(stage => {
                                                                const stageTheme = stateStyle[stage.state];
                                                                const stageIconColor = stage.state === 'pass'
                                                                    ? 'text-emerald-600'
                                                                    : stage.state === 'error'
                                                                        ? 'text-red-600'
                                                                        : stage.state === 'warning'
                                                                            ? 'text-amber-600'
                                                                            : 'text-slate-400';
                                                                return (
                                                                    <div key={stage.id} className="min-w-0 rounded-md border border-slate-200 bg-white/80 px-2 py-1.5 dark:border-slate-700 dark:bg-slate-900/80">
                                                                        <div className="flex items-center gap-1">
                                                                            <stageTheme.Icon size={10} className={stageIconColor} />
                                                                            <span className="truncate text-[9px] font-bold text-slate-700 dark:text-slate-200">{t(acceptanceStageTitleKey(stage), { defaultValue: stage.title })}</span>
                                                                        </div>
                                                                        <div className="mt-0.5 line-clamp-2 break-words text-[8px] leading-3.5 text-slate-500 dark:text-slate-400" title={stage.detail}>{stage.detail}</div>
                                                                    </div>
                                                                );
                                                            })}
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            </section>

                            <section className="grid gap-2 md:grid-cols-2" aria-label={t('acceptance.resourceDependencyAria')}>
                                <div className="rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900/75">
                                    <h3 className="text-xs font-bold text-slate-800 dark:text-slate-100">{t('acceptance.resourceGrowthTitle')}</h3>
                                    <div className="mt-2 grid grid-cols-2 gap-2 text-[10px]"><div>Flash <strong>{formatResourceBytes(report.build.flashUsedBytes ?? Number.NaN)}</strong></div><div>RAM <strong>{formatResourceBytes(report.build.ramUsedBytes ?? Number.NaN)}</strong></div></div>
                                    <div className="mt-2 rounded-lg bg-slate-50 p-2 text-[10px] leading-4 text-slate-600 dark:bg-slate-800/70 dark:text-slate-300"><strong>{report.build.resourceGrowth.summary}</strong><br />{report.build.resourceGrowth.detail}</div>
                                </div>
                                <div className="rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900/75">
                                    <h3 className="text-xs font-bold text-slate-800 dark:text-slate-100">{t('acceptance.dependencyHistoryTitle')}</h3>
                                    <div className="mt-2 text-[10px] leading-5 text-slate-600 dark:text-slate-300">{projectHealthCapabilities(report.target.fqbn).dependencyLock && <>{t('acceptance.lockLabel')}：{report.dependencies.lockAvailable ? t('acceptance.lockRecorded', { count: report.dependencies.entries.length }) : t('acceptance.lockMissing')}<br /></>}{t('acceptance.checkpointLabel')}：{report.history.checkpointCount}<br />{t('acceptance.editCountLabel')}：{t('acceptance.unknown')}</div>
                                </div>
                            </section>

                            <section className="rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900/75" aria-label={t('acceptance.notesAria')}>
                                <div className="flex items-center justify-between gap-2"><h3 className="text-xs font-bold text-slate-800 dark:text-slate-100">{t('acceptance.notesTitle')}</h3><span className="text-[9px] text-slate-400">{t('acceptance.notesHint')}</span></div>
                                <div className="mt-2 grid gap-2 md:grid-cols-2">
                                    <label className="grid gap-1 text-[10px] font-semibold text-slate-600 dark:text-slate-300">{t('acceptance.circuitLabel')}
                                        <textarea value={circuitDescription} onChange={event => setCircuitDescription(event.target.value)} maxLength={10000} rows={4} placeholder={t('acceptance.circuitPlaceholder')} className="resize-y rounded-lg border border-slate-200 bg-white p-2 text-[11px] font-normal leading-5 text-slate-800 outline-none focus:border-brand-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100" />
                                    </label>
                                    <label className="grid gap-1 text-[10px] font-semibold text-slate-600 dark:text-slate-300">{t('acceptance.testLabel')}
                                        <textarea value={testRecords} onChange={event => setTestRecords(event.target.value)} maxLength={10000} rows={4} placeholder={t('acceptance.testPlaceholder')} className="resize-y rounded-lg border border-slate-200 bg-white p-2 text-[11px] font-normal leading-5 text-slate-800 outline-none focus:border-brand-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100" />
                                    </label>
                                </div>
                            </section>

                            <section className="rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-900/75" aria-label={t('acceptance.submission.scopeAria')}>
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                    <div><h3 className="text-xs font-bold text-slate-800 dark:text-slate-100">{t('acceptance.submission.exportHeading')}</h3><p className="mt-0.5 text-[9px] text-slate-500 dark:text-slate-400">{t('acceptance.submission.exportDescription')}</p></div>
                                </div>
                                <div className="mt-3 grid gap-3 md:grid-cols-2">
                                    <label className="grid gap-1 text-[10px] font-semibold text-slate-600 dark:text-slate-300">{t('acceptance.submission.scopeSelectLabel')}
                                        <select value={sourceScope} onChange={event => {
                                            const value = event.target.value as ProjectSubmissionSourceScope;
                                            setSourceScope(value);
                                            if (value === 'no_source') setSourceDisclosureAcknowledged(false);
                                        }} className="h-9 rounded-lg border border-slate-200 bg-white px-2 text-[11px] font-normal text-slate-800 outline-none focus:border-brand-500 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100">
                                            <option value="no_source">{t('acceptance.submission.scope.noSource')}</option>
                                            <option value="editable_project">{t('acceptance.submission.scope.editableProject')}</option>
                                            <option value="generated_source">{t('acceptance.submission.scope.generatedSource')}</option>
                                            <option value="editable_and_generated">{t('acceptance.submission.scope.editableAndGenerated')}</option>
                                        </select>
                                    </label>
                                    <div className="grid content-start gap-2 rounded-lg border border-slate-100 bg-slate-50 p-2.5 text-[10px] text-slate-600 dark:border-slate-800 dark:bg-slate-950/50 dark:text-slate-300">
                                        <label className="flex items-center gap-2"><input type="checkbox" checked={includeBuildEvidence} onChange={event => setIncludeBuildEvidence(event.target.checked)} />{t('acceptance.submission.includeEvidence')}</label>
                                        {projectHealthCapabilities(report.target.fqbn).dependencyLock && <label className={`flex items-center gap-2 ${!report.dependencies.lockAvailable ? 'opacity-50' : ''}`}><input type="checkbox" checked={includeLock} disabled={!report.dependencies.lockAvailable} onChange={event => setIncludeLock(event.target.checked)} />{t('acceptance.submission.includeLock')}</label>}
                                    </div>
                                </div>
                                {sourceScope !== 'no_source' && (
                                    <label className="mt-3 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-[10px] leading-4 text-amber-800 dark:border-amber-900 dark:bg-amber-950/35 dark:text-amber-200">
                                        <input type="checkbox" className="mt-0.5" checked={sourceDisclosureAcknowledged} onChange={event => setSourceDisclosureAcknowledged(event.target.checked)} />
                                        <span><strong>{t('acceptance.submission.disclosureTitle')}</strong>{t('acceptance.submission.disclosureText')}</span>
                                    </label>
                                )}
                                <p className="mt-2 text-[9px] leading-4 text-slate-500 dark:text-slate-400">{t('acceptance.submission.disclosureFooter')}</p>
                            </section>
                        </div>
                    )}
                </main>

                <footer className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-slate-200 bg-white px-5 py-3 dark:border-slate-700 dark:bg-slate-900">
                    <span className="text-[9px] text-slate-400">{t('acceptance.footerNote')}</span>
                    <div className="flex max-w-full flex-wrap items-center justify-end gap-2">
                        <button type="button" onClick={() => void exportReport('json')} disabled={!report || Boolean(busy)} className="flex h-8 items-center gap-1.5 rounded-lg border border-slate-200 px-3 text-xs font-bold text-slate-600 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800">{busy === 'json' ? <Loader2 size={14} className="animate-spin" /> : <FileJson2 size={14} />}{t('acceptance.export.structuredButton')}</button>
                        <button type="button" onClick={() => void exportReport('html')} disabled={!report || Boolean(busy)} title={t('acceptance.export.printableTooltip')} className="flex h-8 items-center gap-1.5 rounded-lg bg-brand-700 px-3 text-xs font-bold text-white hover:bg-brand-800 disabled:opacity-50">{busy === 'html' ? <Loader2 size={14} className="animate-spin" /> : <FileText size={14} />}{t('acceptance.export.printableButton')}</button>
                        <button type="button" onClick={() => void exportSubmission()} disabled={!report || Boolean(busy) || (sourceScope !== 'no_source' && !sourceDisclosureAcknowledged)} className="flex h-8 items-center gap-1.5 rounded-lg bg-slate-900 px-3 text-xs font-bold text-white hover:bg-slate-800 disabled:opacity-50 dark:bg-brand-700 dark:hover:bg-brand-800">{busy === 'ckpkg' ? <Loader2 size={14} className="animate-spin" /> : <PackageCheck size={14} />}{t('acceptance.submission.exportButton')}</button>
                    </div>
                </footer>
            </div>
        </div>
    );
}

export default ProjectAcceptanceReportModal;
