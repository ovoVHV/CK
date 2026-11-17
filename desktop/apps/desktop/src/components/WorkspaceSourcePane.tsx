import { useMemo, useState } from 'react';
import { SourceCodeEditor } from './SourceCodeEditor';
import { sourceDiagnostics } from '../services/source_project';
import './WorkspaceSourcePane.css';

export function WorkspaceSourcePane({ code, documentKey, dark, readOnly, log, onChange, onSave, onBuild, onNotice }: {
    code: string; documentKey: string; dark: boolean; readOnly: boolean; log: string;
    onChange: (value: string) => void; onSave: () => void; onBuild: () => void; onNotice: (message: string) => void;
}) {
    const [cursor, setCursor] = useState({ line: 1, column: 1 });
    const [reveal, setReveal] = useState<{ line: number; column: number; sequence: number } | null>(null);
    const diagnostics = useMemo(() => sourceDiagnostics(log, code), [log, code]);
    return <section className="ck-source-pane" aria-label="工程源码">
        <div className="ck-source-filebar"><strong>sketch.ino</strong><span>Arduino C++</span><small>Ctrl+S 保存工程 · Ctrl+F 查找 · Ctrl+H 替换 · F7 编译</small></div>
        {diagnostics.length > 0 && <div className="ck-source-errors" aria-label="源码诊断">{diagnostics.map((d, i) =>
            <button key={i} onClick={() => setReveal({ ...d, sequence: Date.now() })} title={d.message}><b>第 {d.line} 行</b><span>{d.message}</span></button>)}</div>}
        <div className="ck-source-edit-area"><SourceCodeEditor code={code} documentKey={documentKey} dark={dark} readOnly={readOnly}
            diagnostics={diagnostics} reveal={reveal} onChange={onChange} onSave={onSave} onBuild={onBuild}
            onCursor={(line, column) => setCursor({ line, column })} onRejectedEdit={onNotice} /></div>
        <div className="ck-source-status"><span>第 {cursor.line} 行，第 {cursor.column} 列</span><span>UTF-8</span><span>{readOnly ? '构建中，源码已锁定' : '随当前 CK 工程保存'}</span></div>
    </section>;
}
