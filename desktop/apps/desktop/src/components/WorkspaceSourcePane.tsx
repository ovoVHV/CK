import { useEffect, useMemo, useRef, useState } from 'react';
import { Code2, ChevronDown, FileInput, FileOutput, RefreshCw } from 'lucide-react';
import { SourceCodeEditor } from './SourceCodeEditor';
import { sourceDiagnostics } from '../services/source_project';
import './WorkspaceSourcePane.css';
import { SourceSyncReview } from './SourceSyncReview';
import type { WorkspaceSource } from '../services/workspace_source';
import { useUiText } from '../i18n/uiText';

export function WorkspaceSourcePane({ code, documentKey, active, dirty, followsBlocks, source, onResolve, actionsDisabled, onImport, onExport, onRegenerate, dark, readOnly, log, onChange, onSave, onBuild, onNotice }: {
    code: string; documentKey: string; active: boolean; dirty: boolean; followsBlocks: boolean; actionsDisabled: boolean;
    source: WorkspaceSource; onResolve: (choices: Record<number, 'manual' | 'generated'>) => void;
    onImport: () => void; onExport: () => void; onRegenerate: () => void;
    dark: boolean; readOnly: boolean; log: string;
    onChange: (value: string) => void; onSave: () => void; onBuild: () => void; onNotice: (message: string) => void;
}) {
    const { tr } = useUiText();
    const [cursor, setCursor] = useState({ line: 1, column: 1 });
    const [reveal, setReveal] = useState<{ line: number; column: number; sequence: number } | null>(null);
    const [menuOpen, setMenuOpen] = useState(false);
    const menu = useRef<HTMLDivElement>(null);
    const menuTrigger = useRef<HTMLButtonElement>(null);
    const diagnostics = useMemo(() => sourceDiagnostics(log, code), [log, code]);
    useEffect(() => { setMenuOpen(false); }, [active, documentKey, actionsDisabled]);
    useEffect(() => {
        if (!menuOpen) return;
        const dismiss = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node)) setMenuOpen(false); };
        const escape = (event: KeyboardEvent) => {
            if (event.key === 'Escape') { event.preventDefault(); setMenuOpen(false); menuTrigger.current?.focus(); }
        };
        document.addEventListener('pointerdown', dismiss); document.addEventListener('keydown', escape);
        return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('keydown', escape); };
    }, [menuOpen]);
    const action = (run: () => void) => { setMenuOpen(false); menuTrigger.current?.focus(); run(); };
    return <section className="ck-source-pane" aria-label={tr('工程源码', 'Project Source')}>
        <div className="ck-source-filebar">
            <div className="ck-source-filename"><Code2 size={15} aria-hidden="true" /><strong>sketch.ino</strong>
                {dirty && <span className="ck-source-dirty" title={tr('工程有未保存修改', 'Unsaved project changes')} aria-label={tr('未保存', 'Unsaved')} />}
            </div>
            {active && source.pendingGenerated !== undefined && <SourceSyncReview key={documentKey} source={source} disabled={actionsDisabled} onResolve={onResolve} />}
            <div ref={menu} className="ck-source-menu" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setMenuOpen(false); }}>
                <button ref={menuTrigger} type="button" className="ck-source-menu-trigger" data-ck-role="source-actions" disabled={actionsDisabled}
                    aria-expanded={menuOpen} aria-controls="ck-source-actions" onClick={() => setMenuOpen(value => !value)}>{tr('源码操作', 'Source Actions')}<ChevronDown size={12} /></button>
                {menuOpen && <div id="ck-source-actions" className="ck-source-menu-popup" aria-label={tr('源码操作', 'Source Actions')}>
                    <button type="button" onClick={() => action(onImport)}><FileInput size={14} />{tr('导入 .ino', 'Import .ino')}</button>
                    <button type="button" onClick={() => action(onExport)}><FileOutput size={14} />{tr('导出 .ino', 'Export .ino')}</button>
                    <div className="ck-source-menu-divider" />
                    <button type="button" onClick={() => action(onRegenerate)}><RefreshCw size={14} />{tr('从积木重新生成', 'Regenerate from blocks')}</button>
                    <p>{tr('替换手写内容前会确认', 'Confirmation required before replacing handwritten edits')}</p>
                </div>}
            </div>
        </div>
        {diagnostics.length > 0 && <div className="ck-source-errors" aria-label={tr('源码诊断', 'Source diagnostics')}>{diagnostics.map((d, i) =>
            <button key={i} onClick={() => setReveal({ ...d, sequence: Date.now() })} title={d.message}><b>{tr(`第 ${d.line} 行`, `Line ${d.line}`)}</b><span>{d.message}</span></button>)}</div>}
        <div className="ck-source-edit-area"><SourceCodeEditor code={code} documentKey={documentKey} active={active} dark={dark} readOnly={readOnly}
            diagnostics={diagnostics} reveal={reveal} onChange={onChange} onSave={onSave} onBuild={onBuild}
            onCursor={(line, column) => setCursor({ line, column })} onRejectedEdit={onNotice} /></div>
        <div className="ck-source-status">
            <span title={tr('积木修改会自动合并到源码；同一处冲突时由你选择。手写 C++ 不会反向转换为积木。', 'Block edits merge automatically into source; conflicts ask you to choose. Handwritten C++ does not convert back into blocks.')}>{readOnly ? tr('只读', 'Read-only') : source.pendingGenerated !== undefined ? tr('同步待处理', 'Sync conflict') : followsBlocks ? tr('已与积木同步', 'Synced with blocks') : tr('已同步 · 含手写修改', 'Synced · Custom edits')}</span>
            <span className="ck-source-cursor">{tr(`行 ${cursor.line}，列 ${cursor.column}`, `Ln ${cursor.line}, Col ${cursor.column}`)}</span><span>UTF-8</span><span title={tr('Ctrl+S 保存 · Ctrl+F 查找 · Ctrl+H 替换 · F7 编译', 'Ctrl+S Save · Ctrl+F Find · Ctrl+H Replace · F7 Build')}>Arduino C++</span>
        </div>
    </section>;
}
