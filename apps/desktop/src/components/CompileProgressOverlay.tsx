import { Clock3, Loader2, Upload } from 'lucide-react';
import {
    buildStageIndex,
    formatBuildElapsed,
    formatBuildPercentage,
    type BuildProgressState,
} from '../services/compile_progress';
import type { ProjectBuildEvidenceSeed } from '../services/project_acceptance_report';

interface CompileProgressOverlayProps {
    progress: BuildProgressState;
    buildEvidence: ForegroundBuildEvidence;
}

export interface ForegroundBuildEvidence extends ProjectBuildEvidenceSeed {
    readonly port: string;
    /** Legacy backend request field; equals generatedCodeSha256. */
    readonly workspaceFingerprint: string;
}

const COMPILE_STEPS = ['准备', '编译', '链接', '产物'];

export function CompileProgressOverlay({ progress, buildEvidence }: CompileProgressOverlayProps) {
    const isUpload = progress.mode === 'upload';
    const activeStep = isUpload ? 1 : buildStageIndex(progress.stage);
    const elapsed = formatBuildElapsed(progress.elapsedMs);
    const percentageLabel = formatBuildPercentage(progress.percentage);
    const percentageValue = Math.round(Math.min(100, Math.max(0, progress.percentage)));
    const quietSeconds = Math.floor(progress.quietMs / 1000);
    const isWaiting = progress.stage === 'waiting';
    const isFullBuild = progress.stage === 'full-build';
    const fullBuildLabel = progress.fullBuildKind === 'rebuild'
        ? '正在重建当前配置'
        : '正在执行首次完整构建';
    const explanation = isWaiting
        ? quietSeconds >= 20
            ? `已等待后台预热 ${quietSeconds} 秒，任务仍在正常移交缓存；前台编译会在缓存可用后继续。`
            : '后台预热正在完成同一板卡的缓存，前台会复用结果，不会重复启动完整构建。'
        : quietSeconds >= 20
            ? `编译器已有 ${quietSeconds} 秒没有新输出，但任务仍在运行。ESP32 核心编译期间出现静默属于正常现象。`
            : isFullBuild || progress.fullBuildKind
                ? '首次编译、兼容编译或强制重建需要处理核心与依赖，ESP32 通常需要数分钟；上方计时会持续更新。'
                : '正在检查缓存和编译环境，确定安全路径后会进入编译或直接复用产物。';

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
            className="fixed top-20 left-1/2 -translate-x-1/2 z-[60] w-[380px] max-w-[calc(100vw-24px)] bg-white/97 backdrop-blur-md shadow-2xl rounded-xl border border-slate-200 p-3.5 flex flex-col gap-2.5 animate-in fade-in slide-in-from-top-4 duration-300 dark:border-slate-700 dark:bg-slate-900/97"
            aria-label="编译进度"
        >
            <div className="flex min-w-0 items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                    <div className={`h-7 w-7 rounded-md flex items-center justify-center shrink-0 ${isUpload ? 'bg-teal-50 text-teal-600 dark:bg-teal-950/55 dark:text-teal-300' : 'bg-indigo-50 text-indigo-600 dark:bg-indigo-950/55 dark:text-indigo-300'}`}>
                        {isUpload
                            ? <Upload size={15} className="animate-bounce" />
                            : <Loader2 size={15} className="animate-spin" />}
                    </div>
                    <div className="min-w-0 truncate text-xs font-bold text-slate-800 dark:text-slate-100">
                        {isUpload
                            ? '正在上传固件'
                            : progress.indeterminate && progress.fullBuildKind
                                ? fullBuildLabel
                                : '正在编译工程'}
                    </div>
                </div>

                <div data-ck-role="compile-progress-elapsed" aria-label={`已用时间 ${elapsed}`} className="flex items-center gap-1 text-[11px] font-mono font-bold text-slate-600 shrink-0 dark:text-slate-300">
                    <Clock3 size={12} className="text-slate-400 dark:text-slate-500" />
                    {elapsed}
                </div>
            </div>

            <div
                data-ck-role="compile-progress-message"
                className="truncate text-[10px] text-slate-500 dark:text-slate-400"
                title={progress.message}
                role="status"
                aria-live="polite"
                aria-atomic="true"
            >
                {progress.message || '编译器正在工作'}
            </div>

            <div className="flex min-w-0 items-center gap-2">
                <div
                    className="relative h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800"
                    role="progressbar"
                    aria-label={isUpload ? '固件上传进度' : '工程编译进度'}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={progress.indeterminate ? undefined : percentageValue}
                    aria-valuetext={progress.indeterminate ? '正在处理' : percentageLabel}
                >
                    {progress.indeterminate ? (
                        <div className="ck-progress-indeterminate h-full w-[38%] rounded-full bg-gradient-to-r from-indigo-400 via-blue-500 to-teal-400" />
                    ) : (
                        <div
                            className={`h-full rounded-full transition-[width] duration-300 ease-out ${isUpload ? 'bg-gradient-to-r from-teal-400 to-blue-500' : 'bg-indigo-500'}`}
                            style={{ width: `${Math.min(100, Math.max(2, progress.percentage))}%` }}
                        />
                    )}
                </div>
                {!progress.indeterminate && (
                    <output
                        data-ck-role="compile-progress-percentage"
                        aria-label={`当前进度 ${percentageLabel}`}
                        className="w-[4.5ch] shrink-0 text-right font-mono text-[11px] font-black tabular-nums text-slate-700 dark:text-slate-200"
                    >
                        {percentageLabel}
                    </output>
                )}
            </div>

            {!isUpload && (
                <div className="grid grid-cols-4 gap-1" aria-label="编译阶段">
                    {COMPILE_STEPS.map((label, index) => {
                        const completed = index < activeStep;
                        const active = index === activeStep;
                        return (
                            <div key={label} className="flex items-center gap-1 min-w-0">
                                <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${completed ? 'bg-emerald-500' : active ? 'bg-indigo-500 animate-pulse' : 'bg-slate-200 dark:bg-slate-700'}`} />
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
