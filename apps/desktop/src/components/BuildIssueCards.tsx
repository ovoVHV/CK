import {
    BookOpenCheck,
    Cable,
    CircleAlert,
    CircleHelp,
    Gauge,
    MapPin,
    Settings2,
    TriangleAlert,
} from 'lucide-react';
import type {
    CompileIssueAction,
    CompileIssueCard,
} from '../services/compile_issue_cards';

interface BuildIssueCardsProps {
    issues: CompileIssueCard[];
    onAction: (action: CompileIssueAction, issue: CompileIssueCard) => void;
    onLocateBlock: (blockId: string) => void;
    compact?: boolean;
}

const actionIcon = (action: CompileIssueAction) => {
    if (action.kind === 'library_search') return BookOpenCheck;
    if (action.kind === 'rescan_ports') return Cable;
    if (action.kind === 'show_boot_help') return CircleHelp;
    if (action.kind === 'show_resources') return Gauge;
    if (action.kind === 'open_board_config') return Settings2;
    return CircleHelp;
};

const issueTheme = (issue: CompileIssueCard) => {
    if (issue.severity === 'error') {
        return {
            shell: 'border-red-200 bg-red-50/70 dark:border-red-900 dark:bg-red-950/35',
            icon: 'bg-red-100 text-red-700 dark:bg-red-950/70 dark:text-red-300',
            title: 'text-red-900 dark:text-red-300',
            button: 'border-red-200 bg-white text-red-700 hover:bg-red-100/70 dark:border-red-800 dark:bg-slate-900/75 dark:text-red-300 dark:hover:bg-red-950/55',
            Icon: CircleAlert,
        };
    }
    if (issue.severity === 'warning') {
        return {
            shell: 'border-amber-200 bg-amber-50/70 dark:border-amber-900 dark:bg-amber-950/35',
            icon: 'bg-amber-100 text-amber-700 dark:bg-amber-950/70 dark:text-amber-300',
            title: 'text-amber-900 dark:text-amber-300',
            button: 'border-amber-200 bg-white text-amber-700 hover:bg-amber-100/70 dark:border-amber-800 dark:bg-slate-900/75 dark:text-amber-300 dark:hover:bg-amber-950/55',
            Icon: TriangleAlert,
        };
    }
    return {
        shell: 'border-sky-200 bg-sky-50/70 dark:border-sky-900 dark:bg-sky-950/35',
        icon: 'bg-sky-100 text-sky-700 dark:bg-sky-950/70 dark:text-sky-300',
        title: 'text-sky-900 dark:text-sky-300',
        button: 'border-sky-200 bg-white text-sky-700 hover:bg-sky-100/70 dark:border-sky-800 dark:bg-slate-900/75 dark:text-sky-300 dark:hover:bg-sky-950/55',
        Icon: Settings2,
    };
};

export function BuildIssueCards({
    issues,
    onAction,
    onLocateBlock,
    compact = false,
}: BuildIssueCardsProps) {
    if (issues.length === 0) return null;

    return (
        <section
            className="mx-2 mt-2 grid gap-2 shrink-0"
            aria-label="可操作的编译问题"
        >
            {issues.map((issue) => {
                const theme = issueTheme(issue);
                const StatusIcon = theme.Icon;
                const ActionIcon = issue.action ? actionIcon(issue.action) : null;
                const displayTitle = issue.blockContext
                    ? `“${issue.blockContext.label}”积木错误`
                    : issue.title;
                return (
                    <article
                        key={`${issue.id}:${issue.sourceFile || ''}:${issue.sourceLine ?? ''}:${issue.sourceColumn ?? ''}:${issue.summary}`}
                        className={`rounded-md border ${theme.shell} ${compact ? 'px-2.5 py-2' : 'px-3 py-2.5'}`}
                    >
                        <div className="flex items-start gap-2.5 min-w-0">
                            <div className={`mt-0.5 h-7 w-7 rounded-md flex items-center justify-center shrink-0 ${theme.icon}`}>
                                <StatusIcon size={15} aria-hidden="true" />
                            </div>
                            <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-1.5">
                                    <h3 className={`min-w-0 break-words text-xs font-bold ${theme.title}`}>{displayTitle}</h3>
                                    <span className="rounded border border-white/80 bg-white/70 px-1.5 py-0.5 text-[9px] font-semibold text-slate-500 dark:border-slate-700 dark:bg-slate-900/65 dark:text-slate-400">
                                        {issue.certainty === 'certain' ? '已确认' : '可能'}
                                    </span>
                                </div>
                            </div>
                        </div>

                        {issue.blockContext && (
                            <div className="mt-2 rounded border border-white/90 bg-white/80 px-2.5 py-2 text-[10px] leading-4 text-slate-700 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-200">
                                <div className="break-words">
                                    <span className="font-bold text-slate-500 dark:text-slate-400">积木：</span>
                                    {issue.blockContext.label}
                                </div>
                                <div className="mt-0.5 break-words">
                                    <span className="font-bold text-slate-500 dark:text-slate-400">位置：</span>
                                    {issue.blockContext.flowLocation}
                                </div>
                            </div>
                        )}

                        <div className="mt-2 text-[11px] leading-4 text-slate-700 dark:text-slate-200">
                            <span className="font-bold text-slate-500 dark:text-slate-400">原因：</span>
                            {issue.blockContext && <span className="font-semibold">{issue.title}。 </span>}
                            <span className={compact ? 'text-[10px]' : ''}>{issue.summary}</span>
                        </div>

                        {issue.suggestion && (
                            <div className="mt-1.5 text-[11px] leading-4 text-slate-700 dark:text-slate-200">
                                <span className="font-bold text-slate-500 dark:text-slate-400">建议：</span>
                                <span className={compact ? 'text-[10px]' : ''}>{issue.suggestion}</span>
                            </div>
                        )}

                        {issue.evidence && (
                            <div className="mt-2 rounded border border-slate-200/80 bg-slate-950/[0.035] px-2 py-1.5 dark:border-slate-700 dark:bg-black/20">
                                <div className="mb-0.5 text-[9px] font-bold text-slate-500 dark:text-slate-400">
                                    {issue.sourceLine == null ? '原始诊断证据' : '原始源码证据'}
                                </div>
                                <code className="block whitespace-pre-wrap break-all font-mono text-[9px] leading-4 text-slate-600 dark:text-slate-300">
                                    {issue.evidence}
                                </code>
                            </div>
                        )}

                        {(issue.blockContext || issue.action) && (
                            <div className="mt-2 flex flex-wrap items-center gap-1.5">
                                {issue.blockContext && (
                                    <button
                                        type="button"
                                        onClick={() => onLocateBlock(issue.blockContext!.blockId)}
                                        className="inline-flex min-h-8 items-center gap-1 rounded border border-teal-200 bg-white px-2 text-[10px] font-bold whitespace-nowrap text-teal-700 transition-colors hover:bg-teal-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-600 focus-visible:ring-offset-1 dark:border-teal-800 dark:bg-slate-900/75 dark:text-teal-300 dark:hover:bg-teal-950/55 dark:focus-visible:ring-teal-300 dark:focus-visible:ring-offset-slate-900"
                                        aria-label={`定位积木：${issue.blockContext.label}`}
                                    >
                                        <MapPin size={12} aria-hidden="true" />
                                        <span>定位积木</span>
                                    </button>
                                )}
                                {issue.action && ActionIcon && (
                                    <button
                                        type="button"
                                        onClick={() => onAction(issue.action!, issue)}
                                        className={`inline-flex min-h-8 items-center gap-1 rounded border px-2 text-[10px] font-bold whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-600 focus-visible:ring-offset-1 dark:focus-visible:ring-slate-300 dark:focus-visible:ring-offset-slate-900 ${theme.button}`}
                                        aria-label={`${issue.title}：${issue.action.label}`}
                                    >
                                        <ActionIcon size={12} aria-hidden="true" />
                                        <span>{issue.action.label}</span>
                                    </button>
                                )}
                            </div>
                        )}
                    </article>
                );
            })}
        </section>
    );
}

export default BuildIssueCards;
