import { subscribeBuildActivity } from '../services/build_activity_animation';
import { Clock3, Loader2, Upload } from 'lucide-react';
import {
    buildStageIndex,
    formatBuildElapsed,
    formatBuildPercentage,
    type BuildProgressState,
} from '../services/compile_progress';
import type { ProjectBuildEvidenceSeed } from '../services/project_acceptance_report';
import { useTranslation } from 'react-i18next';
import { useEffect, useRef } from 'react';

interface CompileProgressOverlayProps {
    progress: BuildProgressState;
    buildEvidence: ForegroundBuildEvidence;
}

export interface ForegroundBuildEvidence extends ProjectBuildEvidenceSeed {
    readonly port: string;
    /** Legacy backend request field; equals generatedCodeSha256. */
    readonly workspaceFingerprint: string;
}

const COMPILE_STEP_KEYS = ['progress.step.prepare', 'progress.step.compile', 'progress.step.link', 'progress.step.artifact'] as const;

export function CompileProgressOverlay({ progress, buildEvidence }: CompileProgressOverlayProps) {
    const { t } = useTranslation('build');
    const translate = t as any;
    const isUpload = progress.mode === 'upload';
    const activityIcon = useRef<HTMLDivElement>(null);
    const activityBar = useRef<HTMLDivElement>(null);
    useEffect(() => subscribeBuildActivity(phase => {
        if (activityIcon.current) {
            activityIcon.current.style.transform = phase === null ? 'none' : isUpload
                ? `translateY(${-2 * Math.sin(phase * Math.PI * 2)}px)`
                : `rotate(${phase * 360}deg)`;
        }
        if (activityBar.current) {
            activityBar.current.style.transform = phase === null ? 'none' : `translateX(${-100 + phase * 365}%)`;
            activityBar.current.style.marginLeft = phase === null ? '31%' : '0';
        }
    }), [isUpload, progress.indeterminate]);
    const activeStep = isUpload ? 1 : buildStageIndex(progress.stage);
    const elapsed = formatBuildElapsed(progress.elapsedMs);
    const percentageLabel = formatBuildPercentage(progress.percentage);
    const percentageValue = Math.round(Math.min(100, Math.max(0, progress.percentage)));
    const quietSeconds = Math.floor(progress.quietMs / 1000);
    const isWaiting = progress.stage === 'waiting';
    const isFullBuild = progress.stage === 'full-build';
    const progressMessage = progress.messageCode
        ? translate(progress.messageCode, progress.messageParams)
        : progress.message || t('progress.working');
    const fullBuildLabel = progress.fullBuildKind === 'rebuild'
        ? t('progress.rebuilding')
        : t('progress.firstFullBuild');
    const explanation = isWaiting
        ? quietSeconds >= 20
            ? t('progress.waitingWarmupLong', { seconds: quietSeconds })
            : t('progress.waitingWarmup')
        : quietSeconds >= 20
            ? t('progress.quietLong', { seconds: quietSeconds })
            : isFullBuild || progress.fullBuildKind
                ? t('progress.fullBuildHint')
                : t('progress.checkingPath');

    return (
        <aside
            data-ck-role="compile-progress-overlay"
            data-ck-progress-mode={progress.mode}
            data-ck-progress-stage={progress.stage}
            data-ck-progress-indeterminate={String(progress.indeterminate)}
            data-ck-progress-percentage={percentageValue}
            data-ck-build-evidence-schema={buildEvidence.schemaVersion}
            data-ck-build-run-id={buildEvidence.runId}
            data-ck-build-kind={buildEvidence.kind}
            data-ck-build-fqbn={buildEvidence.fqbn}
            data-ck-build-port={buildEvidence.port}
            data-ck-build-workspace-fingerprint={buildEvidence.workspaceFingerprint}
            className="fixed top-20 left-1/2 -translate-x-1/2 z-[60] w-[380px] max-w-[calc(100vw-24px)] bg-white shadow-2xl rounded-xl border border-slate-200 p-3.5 flex flex-col gap-2.5 animate-in fade-in slide-in-from-top-4 duration-300 dark:border-slate-700 dark:bg-slate-900"
            aria-label={t('progress.compileAria')}
        >
            <div className="flex min-w-0 items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                    <div className="h-7 w-7 rounded-md flex items-center justify-center shrink-0 bg-brand-50 text-brand-600 dark:bg-brand-950/55 dark:text-brand-300">
                        <div className="h-[19px] w-[19px] overflow-hidden [contain:strict] flex items-center justify-center">
                            <div ref={activityIcon} data-ck-role="compile-progress-activity" className="h-[15px] w-[15px]">
                                {isUpload ? <Upload size={15} /> : <Loader2 size={15} />}
                            </div>
                        </div>
                    </div>
                    <div className="min-w-0 truncate text-xs font-bold text-slate-800 dark:text-slate-100">
                        {isUpload
                            ? t('progress.uploadingFirmware')
                            : progress.indeterminate && progress.fullBuildKind
                                ? fullBuildLabel
                                : t('progress.buildingProject')}
                    </div>
                </div>

                <div data-ck-role="compile-progress-elapsed" aria-label={t('progress.elapsedAria', { elapsed })} className="flex items-center gap-1 text-[11px] font-mono font-bold text-slate-600 shrink-0 dark:text-slate-300">
                    <Clock3 size={12} className="text-slate-400 dark:text-slate-500" />
                    {elapsed}
                </div>
            </div>

            <div
                data-ck-role="compile-progress-message"
                className="truncate text-[10px] text-slate-500 dark:text-slate-400"
                title={progress.rawMessage || progressMessage}
                role="status"
                aria-live="polite"
                aria-atomic="true"
            >
                {progressMessage}
            </div>

            <div className="flex min-w-0 items-center gap-2">
                <div
                    className="relative h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800 [contain:paint]"
                    role="progressbar"
                    aria-label={isUpload ? t('progress.uploadAria') : t('progress.projectBuildAria')}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={progress.indeterminate ? undefined : percentageValue}
                    aria-valuetext={progress.indeterminate ? t('progress.processing') : percentageLabel}
                >
                    {progress.indeterminate ? (
                        <div ref={activityBar} className="ck-progress-indeterminate h-full w-[38%] rounded-full bg-gradient-to-r from-brand-600 via-[#ff6a00] to-brand-400" />
                    ) : (
                        <div
                            className="h-full rounded-full transition-[width] duration-300 ease-out bg-gradient-to-r from-brand-600 to-[#ff6a00]"
                            style={{ width: `${Math.min(100, Math.max(2, progress.percentage))}%` }}
                        />
                    )}
                </div>
                {!progress.indeterminate && (
                    <output
                        data-ck-role="compile-progress-percentage"
                        aria-label={t('progress.currentAria', { percentage: percentageLabel })}
                        className="w-[4.5ch] shrink-0 text-right font-mono text-[11px] font-black tabular-nums text-slate-700 dark:text-slate-200"
                    >
                        {percentageLabel}
                    </output>
                )}
            </div>

            {!isUpload && (
                <div className="grid grid-cols-4 gap-1" aria-label={t('progress.stagesAria')}>
                    {COMPILE_STEP_KEYS.map((key, index) => {
                        const label = t(key);
                        const completed = index < activeStep;
                        const active = index === activeStep;
                        return (
                            <div key={key} className="flex items-center gap-1 min-w-0">
                                <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${completed ? 'bg-emerald-500' : active ? 'bg-brand-500' : 'bg-slate-200 dark:bg-slate-700'}`} />
                                <span className={`text-[9px] truncate ${active ? 'font-bold text-slate-700 dark:text-slate-200' : completed ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-400 dark:text-slate-500'}`}>{label}</span>
                            </div>
                        );
                    })}
                </div>
            )}

            {progress.indeterminate && !isUpload && (
                <div data-ck-role="compile-progress-explanation" className={`rounded-md border px-2.5 py-2 text-[10px] leading-4 ${quietSeconds >= 20 ? 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300' : 'border-blue-100 bg-blue-50/70 text-blue-700 dark:border-blue-900 dark:bg-blue-950/35 dark:text-blue-300'}`}>
                    {explanation}
                </div>
            )}
        </aside>
    );
}
