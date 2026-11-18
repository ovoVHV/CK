import { useLayoutEffect, useMemo, useState } from 'react';
import { mergeSource } from '../services/source_merge';
import type { WorkspaceSource } from '../services/workspace_source';

export function SourceSyncReview({ source, disabled, onResolve }: { source: WorkspaceSource; disabled: boolean; onResolve: (choices: Record<number, 'manual' | 'generated'>) => void }) {
    const merge = useMemo(() => mergeSource(source.generatedBase, source.code, source.pendingGenerated!), [source.generatedBase, source.code, source.pendingGenerated]);
    const [open, setOpen] = useState(false);
    const [choices, setChoices] = useState<Record<number, 'manual' | 'generated'>>({});
    useLayoutEffect(() => { setChoices({}); }, [merge]);
    return <section className="ck-source-sync-review" aria-label="源码同步冲突">
        <div className="ck-source-sync-summary"><span role="status">积木已更新 · {merge.conflicts.length ? `${merge.conflicts.length} 处修改需要选择` : '等待确认合并'}</span>
            <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? '收起对比' : '处理冲突'}</button></div>
        {open && <div className="ck-source-sync-details">
            <p>{merge.wholeFile ? '合并后可能超出 1 MiB。请选择要保留的完整源码版本。' : '其他修改自动合并。请逐项选择冲突内容；处理后才能编译当前源码。'}</p>
            {merge.conflicts.map(c => <fieldset key={c.id}><legend>原源码第 {c.line} 行附近</legend>
                <div className="ck-source-sync-options">{(['manual', 'generated'] as const).map(side => <label key={side} data-selected={choices[c.id] === side}>
                    <span><input type="radio" name={`ck-source-conflict-${c.id}`} checked={choices[c.id] === side} disabled={disabled} onChange={() => setChoices(previous => ({ ...previous, [c.id]: side }))} />{side === 'manual' ? '保留手写修改' : '采用积木修改'}</span>
                    <pre>{c.before}<mark>{c[side].length > 6000 ? c[side].slice(0, 6000) + '\n…（长片段仅预览前 6000 字符）' : c[side] || '（删除此处）'}</mark>{c.after}</pre></label>)}</div>
            </fieldset>)}
            <button type="button" className="ck-source-sync-apply" disabled={disabled || merge.conflicts.some(c => !choices[c.id])} onClick={() => onResolve(choices)}>应用合并</button>
        </div>}
    </section>;
}
