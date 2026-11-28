import {
    Activity,
    ArrowDown,
    CircleStop,
    Info,
    LocateFixed,
    Radio,
    Route,
} from 'lucide-react';
import type {
    BlockTraceBlockStat,
    BlockTraceSnapshot,
} from '../services/block_trace';
import { selectChronologicalTraceWindow } from '../services/block_trace';
import { useUiText } from '../i18n/uiText';

export type BlockTracePhase = 'compiling' | 'connecting' | 'running' | 'stopping' | 'unresponsive';

export interface BlockTracePanelProps {
    phase: BlockTracePhase;
    snapshot: BlockTraceSnapshot | null;
    maxFirmwareFramesPerSecond?: number;
    onLocateBlock: (blockId: string) => void;
    onStop: () => void;
    onAbandon: () => void;
}

const formatDuration = (microseconds: number | null, tr: (zh: string, en: string) => string): string => {
    if (microseconds == null) return tr('本段起点', 'Segment start');
    if (microseconds < 1000) return `${microseconds} μs`;
    if (microseconds < 1_000_000) return `${(microseconds / 1000).toFixed(1)} ms`;
    return `${(microseconds / 1_000_000).toFixed(2)} s`;
};

const phaseText = (phase: BlockTracePhase, tr: (zh: string, en: string) => string): string => {
    if (phase === 'compiling') return tr('正在编译并上传轨迹固件', 'Compiling and uploading trace firmware');
    if (phase === 'connecting') return tr('正在连接串口并附加轨迹会话', 'Connecting serial port and attaching trace session');
    if (phase === 'stopping') return tr('正在结束轨迹，等待开发板确认', 'Stopping trace and waiting for board confirmation');
    if (phase === 'unresponsive') return tr('开发板未确认结束，状态未知。可重试或退出桌面会话后普通上传。', 'The board did not confirm stop; state is unknown. Retry or leave the desktop session and upload normally.');
    return tr('非暂停采样中', 'Live sampling (non-pausing)');
};

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
    onAbandon,
}: BlockTracePanelProps) {
    const { tr } = useUiText();
    const coverage = snapshot?.coveragePercent || 0;
    const latest = selectChronologicalTraceWindow(snapshot, 8);
    const current = latest.length > 0 ? latest[latest.length - 1] : null;
    const coveredStats = snapshot ? recentStats(snapshot) : [];

    return (
        <aside
            data-ck-role="block-trace-panel"
            data-ck-trace-phase={phase}
            className="fixed top-20 right-4 z-[65] flex max-h-[calc(100vh-96px)] w-[360px] max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-xl border border-emerald-200 bg-white/97 shadow-2xl backdrop-blur-md dark:border-emerald-900 dark:bg-slate-900/97"
            aria-label={tr('积木运行轨迹与采样覆盖率', 'Block execution trace and sampling coverage')}
        >
            <div className="shrink-0 border-b border-slate-100 px-3.5 py-3 dark:border-slate-800">
                <div className="flex items-start gap-2.5">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300">
                        {phase === 'running' ? <Radio size={16} className="animate-pulse" /> : <Route size={16} />}
                    </span>
                    <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-bold text-slate-800 dark:text-slate-100">{tr('运行轨迹', 'Execution Trace')}</span>
                            <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[9px] font-bold text-emerald-700 dark:bg-emerald-950/55 dark:text-emerald-300">
                                {phase === 'running' ? tr('真机采样 · 非模拟', 'Hardware sampling · Live') : tr('准备真机轨迹', 'Preparing trace')}
                            </span>
                        </div>
                        <p className="mt-1 text-[10px] text-slate-600 dark:text-slate-300">{phaseText(phase, tr)}</p>
                    </div>
                </div>

                <div className="mt-3 flex items-end justify-between gap-3">
                    <div>
                        <span className="text-2xl font-black tabular-nums text-emerald-700 dark:text-emerald-300">{coverage.toFixed(0)}%</span>
                        <span className="ml-1 text-[9px] text-slate-400 dark:text-slate-500">{tr('已纳入积木的采样覆盖', 'sampled coverage of tracked blocks')}</span>
                    </div>
                    <div className="text-right text-[9px] leading-4 text-slate-500 dark:text-slate-400">
                        <div>{tr(`${snapshot?.coveredBlockCount || 0} / ${snapshot?.trackedBlockCount || 0} 个积木`, `${snapshot?.coveredBlockCount || 0} / ${snapshot?.trackedBlockCount || 0} blocks`)}</div>
                        <div>{tr(`${snapshot?.totalSampledHits || 0} 次采样命中`, `${snapshot?.totalSampledHits || 0} sampled hits`)}</div>
                    </div>
                </div>
                <div className="mt-2 text-[10px] text-slate-600 dark:text-slate-300" data-ck-role="trace-scope">
                    {tr(`第 ${snapshot?.runNumber || 1} 轮 · 已纳入 ${snapshot?.trackedBlockCount || 0} 个 · 未纳入 ${snapshot?.omittedTrackedBlockCount || 0} 个`, `Run #${snapshot?.runNumber || 1} · ${snapshot?.trackedBlockCount || 0} tracked · ${snapshot?.omittedTrackedBlockCount || 0} omitted`)}
                    {(snapshot?.omittedTrackedBlockCount || 0) > 0 && <p className="mt-1 text-amber-700 dark:text-amber-300">{tr('未纳入部分受固件容量或安全插桩范围限制；100% 不代表整个工程全部执行。', 'Omitted blocks are outside firmware budget or safe instrumentation limits; 100% does not mean every block ran.')}</p>}
                </div>
                <div
                    className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800"
                    role="progressbar"
                    aria-label={tr('积木采样覆盖率', 'Block sampling coverage')}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Number(coverage.toFixed(1))}
                >
                    <div className="h-full rounded-full bg-emerald-500 transition-[width] duration-200" style={{ width: `${Math.min(100, coverage)}%` }} />
                </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2.5">
                <section className="mb-3 rounded-lg border border-sky-100 bg-sky-50/75 p-2.5 dark:border-sky-900/70 dark:bg-sky-950/25" aria-label={tr('运行轨迹使用说明', 'Execution trace guide')}>
                    <div className="flex items-center gap-1.5 text-[10px] font-black text-sky-800 dark:text-sky-200">
                        <Info size={12} />{tr('怎么看运行轨迹', 'How to read execution trace')}
                    </div>
                    <ol className="mt-1.5 grid gap-1 text-[9px] leading-4 text-sky-900/80 dark:text-sky-100/75">
                        <li><strong>1.</strong> {tr('下方编号从上往下就是开发板回报的采样顺序。', 'Items below are ordered top-to-bottom as reported by the board.')}</li>
                        <li><strong>2.</strong> {tr('蓝绿色外圈是最新收到的采样点；绿色是曾采样经过；灰色是尚未采样。', 'Cyan outline marks the latest sample; green marks previously sampled blocks; gray is not yet sampled.')}</li>
                        <li><strong>3.</strong> {tr('点击任意一步，会在画布中定位对应积木。', 'Click any step to locate the corresponding block on the canvas.')}</li>
                    </ol>
                    <p className="mt-1.5 border-t border-sky-100 pt-1.5 text-[9px] leading-4 text-sky-700 dark:border-sky-900/70 dark:text-sky-300">
                        {tr('这是轨迹固件从真机串口返回的抽样，不是动画模拟；高速代码会跳过部分步骤，因此它表示“采样先后”，不是逐条指令录像。', 'Samples come from real hardware over serial, not animation simulation. Fast loops may skip intermediate steps, so this shows sampling order rather than every instruction.')}
                    </p>
                </section>

                {phase === 'running' && current && (
                    <button
                        type="button"
                        onClick={() => onLocateBlock(current.blockId)}
                        className="mb-3 flex w-full items-center gap-2.5 rounded-lg border border-cyan-300 bg-cyan-50 px-2.5 py-2 text-left shadow-sm hover:bg-cyan-100 dark:border-cyan-800 dark:bg-cyan-950/35 dark:hover:bg-cyan-950/55"
                    >
                        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-cyan-500 text-[10px] font-black text-white">{tr('最新', 'Now')}</span>
                        <span className="min-w-0 flex-1">
                            <strong className="block truncate text-[11px] text-cyan-950 dark:text-cyan-100">{current.blockLabel}</strong>
                            <small className="block truncate text-[9px] text-cyan-700 dark:text-cyan-300">
                                {current.previousBlockLabel ? tr(`上一条采样记录：${current.previousBlockLabel}`, `Previous sample: ${current.previousBlockLabel}`) : tr('本轮收到的第一条采样记录', 'First sample received in this run')}
                            </small>
                        </span>
                        <LocateFixed size={13} className="shrink-0 text-cyan-700 dark:text-cyan-300" />
                    </button>
                )}

                {latest.length > 0 ? (
                    <section aria-label={tr('真机采样接收顺序', 'Hardware sample order')}>
                        <div className="mb-1.5 flex items-center gap-1 text-[10px] font-bold text-slate-600 dark:text-slate-300">
                            <Activity size={12} />{tr('采样记录顺序', 'Sample sequence')} <span className="font-normal text-slate-400">{tr('（从上往下）', '(top to bottom)')}</span>
                        </div>
                        <ol>
                            {latest.map((item, index) => (
                                <li key={item.sequenceNumber}>
                                    <button
                                        type="button"
                                        onClick={() => onLocateBlock(item.blockId)}
                                        className={`flex w-full min-w-0 items-center gap-2 rounded border px-2 py-1.5 text-left ${index === latest.length - 1
                                            ? 'border-cyan-300 bg-cyan-50 hover:bg-cyan-100 dark:border-cyan-800 dark:bg-cyan-950/35'
                                            : 'border-slate-100 bg-slate-50/70 hover:border-emerald-200 hover:bg-emerald-50/60 dark:border-slate-700 dark:bg-slate-800/70 dark:hover:border-emerald-800 dark:hover:bg-emerald-950/35'}`}
                                    >
                                        <span className={`flex h-5 min-w-7 shrink-0 items-center justify-center rounded px-1 font-mono text-[8px] font-black ${index === latest.length - 1
                                            ? 'bg-cyan-500 text-white'
                                            : 'bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300'}`}>#{item.sequenceNumber}</span>
                                        <span className="min-w-0 flex-1">
                                            <strong className="block truncate text-[10px] text-slate-700 dark:text-slate-200">{item.blockLabel}</strong>
                                            <small className="block truncate text-[8px] text-slate-400 dark:text-slate-500">
                                                {item.previousBlockLabel ? tr(`上一条：${item.previousBlockLabel}`, `Prev: ${item.previousBlockLabel}`) : tr('本段起点', 'Segment start')}
                                            </small>
                                        </span>
                                        {item.firstHit && <span className="shrink-0 rounded bg-emerald-100 px-1 py-0.5 text-[8px] font-bold text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">{tr('首次', 'First')}</span>}
                                        <span className="shrink-0 font-mono text-[9px] text-slate-400 dark:text-slate-500">{formatDuration(item.transitionUs, tr)}</span>
                                    </button>
                                    {index < latest.length - 1 && (
                                        <div className="flex h-4 items-center pl-4 text-slate-300 dark:text-slate-600" aria-hidden="true">
                                            <ArrowDown size={10} />
                                        </div>
                                    )}
                                </li>
                            ))}
                        </ol>
                    </section>
                ) : (
                    <div className="rounded border border-dashed border-slate-200 px-3 py-4 text-center text-[10px] leading-5 text-slate-400 dark:border-slate-700 dark:text-slate-500">
                        <strong className="block text-slate-600 dark:text-slate-300">{tr('等待第一条真机采样', 'Waiting for first hardware sample')}</strong>
                        {tr('让开发板运行，或触发按钮、传感器、网络等条件；收到数据后这里会按顺序列出。', 'Let the board run or trigger a button, sensor, or network event. Received samples will appear here in order.')}
                    </div>
                )}

                {coveredStats.length > 0 && (
                    <section className="mt-3" aria-label={tr('积木采样统计', 'Block sampling counts')}>
                        <div className="mb-1.5 text-[10px] font-bold text-slate-600 dark:text-slate-300">{tr('命中统计', 'Hit counts')} <span className="font-normal text-slate-400">{tr('（不代表执行顺序）', '(not execution order)')}</span></div>
                        <div className="flex flex-wrap gap-1">
                            {coveredStats.map(stat => (
                                <button
                                    key={stat.blockId}
                                    type="button"
                                    onClick={() => onLocateBlock(stat.blockId)}
                                    className="inline-flex max-w-full items-center gap-1 rounded border border-emerald-100 bg-emerald-50 px-1.5 py-1 text-[9px] text-emerald-800 hover:border-emerald-300 dark:border-emerald-900 dark:bg-emerald-950/45 dark:text-emerald-300 dark:hover:border-emerald-700"
                                    title={tr(`${stat.label}：采样命中 ${stat.sampledHits} 次`, `${stat.label}: ${stat.sampledHits} sampled hits`)}
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
                    {tr(`次数是采样命中，不是精确执行次数；积木间时间取自开发板采样点。首次覆盖会按真机到达顺序保留，之后稳定采样最多约 ${maxFirmwareFramesPerSecond} 帧/秒；追踪会有少量运行和串口开销。`, `Counts reflect sampled hits rather than exact executions; intervals come from board timestamps. First hits preserve arrival order, then steady sampling caps around ${maxFirmwareFramesPerSecond} frames/s with minor runtime and serial overhead.`)}
                </p>
                {(snapshot?.droppedRateLimitedEvents || 0) > 0 && (
                    <p className="mt-1 text-[9px] text-amber-700 dark:text-amber-300">
                        {tr(`桌面端保护性丢弃 ${snapshot?.droppedRateLimitedEvents} 条超限轨迹帧。`, `Dropped ${snapshot?.droppedRateLimitedEvents} rate-limited trace frames to protect the desktop UI.`)}
                    </p>
                )}
                <div className="mt-2 flex justify-end">
                    {phase === 'unresponsive' && <button type="button" onClick={onAbandon} className="mr-2 rounded border border-amber-400 px-2 text-xs text-amber-700 dark:text-amber-300">{tr('退出桌面会话', 'Leave desktop session')}</button>}
                    <button
                        type="button"
                        onClick={onStop}
                        disabled={phase === 'stopping'}
                        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-red-200 bg-red-50 px-3 text-xs font-bold text-red-700 hover:bg-red-100 disabled:cursor-wait disabled:opacity-50 dark:border-red-900 dark:bg-red-950/45 dark:text-red-300 dark:hover:bg-red-950/70"
                    >
                        <CircleStop size={14} />{tr('结束轨迹', 'Stop trace')}
                    </button>
                </div>
            </div>
        </aside>
    );
}

export default BlockTracePanel;
