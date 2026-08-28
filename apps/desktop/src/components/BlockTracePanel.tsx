import {
    Activity,
    CircleStop,
    LocateFixed,
    Radio,
    Route,
} from 'lucide-react';
import type {
    BlockTraceBlockStat,
    BlockTraceSnapshot,
    BlockTraceTransition,
} from '../services/block_trace';

export type BlockTracePhase = 'compiling' | 'connecting' | 'running' | 'stopping';

export interface BlockTracePanelProps {
    phase: BlockTracePhase;
    snapshot: BlockTraceSnapshot | null;
    maxFirmwareFramesPerSecond?: number;
    onLocateBlock: (blockId: string) => void;
    onStop: () => void;
}

const formatDuration = (microseconds: number | null): string => {
    if (microseconds == null) return '起点';
    if (microseconds < 1000) return `${microseconds} μs`;
    if (microseconds < 1_000_000) return `${(microseconds / 1000).toFixed(1)} ms`;
    return `${(microseconds / 1_000_000).toFixed(2)} s`;
};

const phaseText = (phase: BlockTracePhase): string => {
    if (phase === 'compiling') return '正在编译并上传轨迹固件';
    if (phase === 'connecting') return '正在连接串口并附加轨迹会话';
    if (phase === 'stopping') return '正在结束轨迹，等待开发板确认';
    return '非暂停采样中';
};

const recentTitle = (transition: BlockTraceTransition): string => (
    transition.previousBlockLabel
        ? `${transition.previousBlockLabel} → ${transition.blockLabel}`
        : transition.blockLabel
);

const recentStats = (snapshot: BlockTraceSnapshot): BlockTraceBlockStat[] => (
    snapshot.stats
        .filter(stat => stat.covered)
        .sort((left, right) => (right.lastSeenAtMs || 0) - (left.lastSeenAtMs || 0))
        .slice(0, 6)
);

export function BlockTracePanel({
    phase,
    snapshot,
    maxFirmwareFramesPerSecond = 25,
    onLocateBlock,
    onStop,
}: BlockTracePanelProps) {
    const coverage = snapshot?.coveragePercent || 0;
    const latest = snapshot ? [...snapshot.recent].reverse().slice(0, 5) : [];
    const coveredStats = snapshot ? recentStats(snapshot) : [];

    return (
        <aside
            data-ck-role="block-trace-panel"
            data-ck-trace-phase={phase}
            className="fixed top-20 right-4 z-[65] flex max-h-[calc(100vh-96px)] w-[360px] max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-xl border border-emerald-200 bg-white/97 shadow-2xl backdrop-blur-md dark:border-emerald-900 dark:bg-slate-900/97"
            aria-label="积木运行轨迹与采样覆盖率"
        >
            <div className="shrink-0 border-b border-slate-100 px-3.5 py-3 dark:border-slate-800">
                <div className="flex items-start gap-2.5">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300">
                        {phase === 'running' ? <Radio size={16} className="animate-pulse" /> : <Route size={16} />}
                    </span>
                    <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-bold text-slate-800 dark:text-slate-100">运行轨迹</span>
                            <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[9px] font-bold text-emerald-700 dark:bg-emerald-950/55 dark:text-emerald-300">
                                采样模式
                            </span>
                        </div>
                        <p className="mt-1 text-[10px] text-slate-600 dark:text-slate-300">{phaseText(phase)}</p>
                    </div>
                </div>

                <div className="mt-3 flex items-end justify-between gap-3">
                    <div>
                        <span className="text-2xl font-black tabular-nums text-emerald-700 dark:text-emerald-300">{coverage.toFixed(0)}%</span>
                        <span className="ml-1 text-[9px] text-slate-400 dark:text-slate-500">采样覆盖</span>
                    </div>
                    <div className="text-right text-[9px] leading-4 text-slate-500 dark:text-slate-400">
                        <div>{snapshot?.coveredBlockCount || 0} / {snapshot?.trackedBlockCount || 0} 个积木</div>
                        <div>{snapshot?.totalSampledHits || 0} 次采样命中</div>
                    </div>
                </div>
                <div
                    className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800"
                    role="progressbar"
                    aria-label="积木采样覆盖率"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Number(coverage.toFixed(1))}
                >
                    <div className="h-full rounded-full bg-emerald-500 transition-[width] duration-200" style={{ width: `${Math.min(100, coverage)}%` }} />
                </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2.5">
                {latest.length > 0 ? (
                    <section aria-label="最近采样路径">
                        <div className="mb-1.5 flex items-center gap-1 text-[10px] font-bold text-slate-600 dark:text-slate-300">
                            <Activity size={12} />最近路径
                        </div>
                        <div className="grid gap-1">
                            {latest.map((item, index) => (
                                <button
                                    key={`${item.receivedAtMs}:${item.blockId}:${index}`}
                                    type="button"
                                    onClick={() => onLocateBlock(item.blockId)}
                                    className="flex min-w-0 items-center gap-2 rounded border border-slate-100 bg-slate-50/70 px-2 py-1.5 text-left hover:border-emerald-200 hover:bg-emerald-50/60 dark:border-slate-700 dark:bg-slate-800/70 dark:hover:border-emerald-800 dark:hover:bg-emerald-950/35"
                                >
                                    <span className={`h-2 w-2 shrink-0 rounded-full ${item.firstHit ? 'bg-emerald-500' : 'bg-sky-400'}`} />
                                    <span className="min-w-0 flex-1 truncate text-[9px] text-slate-600 dark:text-slate-300" title={recentTitle(item)}>
                                        {recentTitle(item)}
                                    </span>
                                    <span className="shrink-0 font-mono text-[9px] text-slate-400 dark:text-slate-500">{formatDuration(item.transitionUs)}</span>
                                </button>
                            ))}
                        </div>
                    </section>
                ) : (
                    <div className="rounded border border-dashed border-slate-200 px-3 py-4 text-center text-[10px] text-slate-400 dark:border-slate-700 dark:text-slate-500">
                        等待第一条积木采样轨迹
                    </div>
                )}

                {coveredStats.length > 0 && (
                    <section className="mt-3" aria-label="积木采样统计">
                        <div className="mb-1.5 text-[10px] font-bold text-slate-600 dark:text-slate-300">最近命中的积木</div>
                        <div className="flex flex-wrap gap-1">
                            {coveredStats.map(stat => (
                                <button
                                    key={stat.blockId}
                                    type="button"
                                    onClick={() => onLocateBlock(stat.blockId)}
                                    className="inline-flex max-w-full items-center gap-1 rounded border border-emerald-100 bg-emerald-50 px-1.5 py-1 text-[9px] text-emerald-800 hover:border-emerald-300 dark:border-emerald-900 dark:bg-emerald-950/45 dark:text-emerald-300 dark:hover:border-emerald-700"
                                    title={`${stat.label}：采样命中 ${stat.sampledHits} 次`}
                                >
                                    <LocateFixed size={9} />
                                    <span className="max-w-[190px] truncate">{stat.label}</span>
                                    <strong className="font-mono">×{stat.sampledHits}</strong>
                                </button>
                            ))}
                        </div>
                    </section>
                )}
            </div>

            <div className="shrink-0 border-t border-slate-100 bg-slate-50/80 px-3 py-2.5 dark:border-slate-800 dark:bg-slate-800/65">
                <p className="text-[9px] leading-4 text-slate-500 dark:text-slate-400">
                    次数是采样命中，不是精确执行次数；积木间时间取自开发板采样点。固件最多约 {maxFirmwareFramesPerSecond} 帧/秒，追踪会有少量运行和串口开销。
                </p>
                {(snapshot?.droppedRateLimitedEvents || 0) > 0 && (
                    <p className="mt-1 text-[9px] text-amber-700 dark:text-amber-300">
                        桌面端保护性丢弃 {snapshot?.droppedRateLimitedEvents} 条超限轨迹帧。
                    </p>
                )}
                <div className="mt-2 flex justify-end">
                    <button
                        type="button"
                        onClick={onStop}
                        disabled={phase === 'stopping'}
                        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-red-200 bg-red-50 px-3 text-xs font-bold text-red-700 hover:bg-red-100 disabled:cursor-wait disabled:opacity-50 dark:border-red-900 dark:bg-red-950/45 dark:text-red-300 dark:hover:bg-red-950/70"
                    >
                        <CircleStop size={14} />结束轨迹
                    </button>
                </div>
            </div>
        </aside>
    );
}

export default BlockTracePanel;
