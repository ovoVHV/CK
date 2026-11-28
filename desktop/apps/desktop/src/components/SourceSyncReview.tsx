import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { GitMerge, X } from 'lucide-react';
import { mergeSource } from '../services/source_merge';
import type { WorkspaceSource } from '../services/workspace_source';
import { useUiText } from '../i18n/uiText';

export function SourceSyncReview({ source, disabled, onResolve }: { source: WorkspaceSource; disabled: boolean; onResolve: (choices: Record<number, 'manual' | 'generated'>) => void }) {
    const { tr } = useUiText();
    const merge = useMemo(() => mergeSource(source.generatedBase, source.code, source.pendingGenerated!), [source.generatedBase, source.code, source.pendingGenerated]);
    const [open, setOpen] = useState(false);
    const [choices, setChoices] = useState<Record<number, 'manual' | 'generated'>>({});
    const id = useId(), root = useRef<HTMLElement>(null), trigger = useRef<HTMLButtonElement>(null), close = useRef<HTMLButtonElement>(null);
    useLayoutEffect(() => { setChoices({}); }, [merge]);
    useEffect(() => {
        if (!open) return;
        close.current?.focus({preventScroll:true});
        const outside = (e:PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
        const escape = (e:KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); setOpen(false); trigger.current?.focus(); } };
        document.addEventListener('pointerdown',outside); document.addEventListener('keydown',escape);
        return () => { document.removeEventListener('pointerdown',outside); document.removeEventListener('keydown',escape); };
    }, [open]);
    return <section ref={root} className="ck-source-sync-review" aria-label={tr('源码同步冲突', 'Source Sync Conflicts')}>
        <div className="ck-source-sync-summary"><button ref={trigger} type="button" onClick={() => setOpen(!open)} aria-haspopup="dialog" aria-controls={open?id:undefined} aria-expanded={open}>
            <GitMerge size={14}/>{tr('同步冲突', 'Sync Conflicts')}{merge.conflicts.length > 0 && <b>{merge.conflicts.length}</b>}</button></div>
        {open && <div id={id} role="dialog" aria-label={tr('处理源码同步冲突', 'Resolve Source Sync Conflicts')} className="ck-source-sync-details">
            <header><GitMerge size={16}/><strong>{tr('处理同步冲突', 'Resolve Sync Conflicts')}</strong><button ref={close} title={tr('收起对比', 'Collapse diff')} aria-label={tr('收起对比', 'Collapse diff')} type="button" onClick={() => { setOpen(false); trigger.current?.focus(); }}><X size={16}/></button></header>
            <div className="ck-conflict-scroll">
            {merge.wholeFile && <p>{tr('合并可能超出 1 MiB，请选择完整版本。', 'The merged result may exceed 1 MiB. Please choose a full version.')}</p>}
            {merge.conflicts.map(c => <fieldset key={c.id}><legend>{tr(`原源码第 ${c.line} 行附近`, `Around line ${c.line}`)}</legend>
                <div className="ck-source-sync-options">{(['manual', 'generated'] as const).map(side => <label key={side} data-selected={choices[c.id] === side}>
                    <span><input type="radio" name={`ck-source-conflict-${c.id}`} checked={choices[c.id] === side} disabled={disabled} onChange={() => setChoices(previous => ({ ...previous, [c.id]: side }))} />{side === 'manual' ? tr('保留手写修改', 'Keep handwritten edits') : tr('采用积木修改', 'Use generated blocks')}</span>
                    <pre>{c.before}<mark>{c[side].length > 6000 ? c[side].slice(0, 6000) + tr('\n…（长片段仅预览前 6000 字符）', '\n… (preview truncated to first 6,000 characters)') : c[side] || tr('（删除此处）', '(delete this block)')}</mark>{c.after}</pre></label>)}</div>
            </fieldset>)}
            </div><footer><span>{tr(`${Object.keys(choices).length} / ${merge.conflicts.length} 已选择`, `${Object.keys(choices).length} / ${merge.conflicts.length} resolved`)}</span><button type="button" className="ck-source-sync-apply" disabled={disabled || merge.conflicts.some(c => !choices[c.id])} onClick={() => onResolve(choices)}>{tr('应用合并', 'Apply Merge')}</button></footer>
        </div>}
    </section>;
}
