import { Bug, CircleStop, Footprints, Play, Radio } from 'lucide-react';
import type { BlockDebugPhase } from '../services/block_debug_session';

export type { BlockDebugPhase } from '../services/block_debug_session';

interface BlockDebugControlsProps {
    phase: BlockDebugPhase;
    breakpointCount: number;
    pausedBlockLabel?: string;
    onContinue: () => void;
    onStep: () => void;
    onStop: () => void;
    onAbandon: () => void;
    pendingCommand?: 'CONTINUE' | 'STEP' | null;
}

const phaseMessage = (phase: BlockDebugPhase, pausedBlockLabel?: string): string => {
    if (phase === 'compiling') return '正在编译并上传带断点的调试固件';
    if (phase === 'connecting') return '正在连接串口并附加开发板调试会话';
    if (phase === 'paused') return pausedBlockLabel ? `已暂停：${pausedBlockLabel}` : '已在积木断点暂停';
    if (phase === 'stopping') return '正在结束调试，等待开发板确认';
    if (phase === 'unresponsive') return '开发板未确认命令，当前运行状态未知。可重试结束或退出桌面会话后普通上传。';
    return '程序正在运行，等待命中断点';
};

export function BlockDebugControls({
    phase,
    breakpointCount,
    pausedBlockLabel,
    onContinue,
    onStep,
    onStop,
    onAbandon,
    pendingCommand,
}: BlockDebugControlsProps) {
    const paused = phase === 'paused';

    return (
        <aside
            data-ck-role="block-debug-controls"
            data-ck-debug-phase={phase}
            className={`fixed top-20 right-4 z-[65] w-[330px] max-w-[calc(100vw-24px)] rounded-xl border bg-white/97 backdrop-blur-md p-3.5 shadow-2xl dark:bg-slate-900/97 ${paused ? 'border-amber-300 dark:border-amber-700' : 'border-violet-200 dark:border-violet-800'}`}
            aria-label="积木调试控制"
        >
            <div className="flex items-start gap-2.5">
                <div className={`h-8 w-8 shrink-0 rounded-lg flex items-center justify-center ${paused ? 'bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300' : 'bg-violet-100 text-violet-700 dark:bg-violet-950/60 dark:text-violet-300'}`}>
                    {phase === 'running' ? <Radio size={16} className="animate-pulse" /> : <Bug size={16} />}
                </div>
                <div className="min-w-0 flex-1" role="status" aria-live="polite">
                    <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-bold text-slate-800 dark:text-slate-100">积木调试</span>
                        <span className="text-[9px] font-bold text-violet-600 bg-violet-50 rounded px-1.5 py-0.5 dark:bg-violet-950/55 dark:text-violet-300">
                            {breakpointCount} 个断点
                        </span>
                    </div>
                    <p className="mt-1 text-[10px] leading-4 text-slate-600 break-words dark:text-slate-300">
                        {pendingCommand ? `已发送${pendingCommand === 'STEP' ? '单步' : '继续'}，等待开发板确认` : phaseMessage(phase, pausedBlockLabel)}
                    </p>
                </div>
            </div>

            <div className="mt-3 flex items-center justify-end gap-2">
                {paused && (
                    <>
                        <button
                            type="button"
                            onClick={onContinue}
                            disabled={Boolean(pendingCommand)}
                            className="h-8 px-3 rounded-md bg-violet-600 hover:bg-violet-700 text-white text-xs font-bold inline-flex items-center gap-1.5"
                        >
                            <Play size={14} />继续
                        </button>
                        <button
                            type="button"
                            onClick={onStep}
                            disabled={Boolean(pendingCommand)}
                            className="h-8 px-3 rounded-md border border-violet-200 bg-white hover:bg-violet-50 text-violet-700 text-xs font-bold inline-flex items-center gap-1.5 dark:border-violet-800 dark:bg-slate-800 dark:text-violet-300 dark:hover:bg-violet-950/55"
                        >
                            <Footprints size={14} />单步
                        </button>
                    </>
                )}
                {phase === 'unresponsive' && (
                    <button type="button" onClick={onAbandon} className="h-8 rounded border border-amber-400 px-2 text-xs text-amber-700 dark:text-amber-300">退出桌面会话</button>
                )}
                <button
                    type="button"
                    onClick={onStop}
                    disabled={phase === 'stopping'}
                    className="h-8 px-3 rounded-md border border-red-200 bg-red-50 hover:bg-red-100 text-red-700 text-xs font-bold inline-flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-wait dark:border-red-900 dark:bg-red-950/45 dark:text-red-300 dark:hover:bg-red-950/70"
                >
                    <CircleStop size={14} />结束调试
                </button>
            </div>
        </aside>
    );
}
