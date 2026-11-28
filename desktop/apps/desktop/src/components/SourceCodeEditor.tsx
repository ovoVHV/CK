import { useEffect, useLayoutEffect, useRef } from 'react';
import { basicSetup } from 'codemirror';
import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { arduinoCpp, codeTheme, cppConstants } from './arduinoHighlight';
import { setDiagnostics } from '@codemirror/lint';
import { openSearchPanel } from '@codemirror/search';
import type { SourceDiagnostic } from '../services/source_project';
import { uiText } from '../i18n/uiText';

export function SourceCodeEditor({ code, documentKey, dark, readOnly, active = true, diagnostics, reveal, onChange, onSave, onBuild, onCursor, onRejectedEdit }: {
    code: string; documentKey: string; active?: boolean; dark: boolean; readOnly: boolean; diagnostics: SourceDiagnostic[];
    reveal: { line: number; column: number; sequence: number } | null;
    onChange: (code: string) => void; onSave: () => void; onBuild: () => void;
    onCursor: (line: number, column: number) => void;
    onRejectedEdit: (reason: string) => void;
}) {
    const mount = useRef<HTMLDivElement>(null); const view = useRef<EditorView | null>(null);
    const config = useRef({ onChange, onSave, onBuild, onCursor, onRejectedEdit }); config.current = { onChange, onSave, onBuild, onCursor, onRejectedEdit };
    const theme = useRef(new Compartment()), editable = useRef(new Compartment());
    useLayoutEffect(() => {
        if (!mount.current) return;
        const editor = new EditorView({ parent: mount.current, state: EditorState.create({ doc: code, extensions: [
            keymap.of([{ key: 'Mod-s', run: () => { config.current.onSave(); return true; } },
                { key: 'Mod-h', scope: 'editor search-panel', run: view => { openSearchPanel(view); view.dom.querySelector<HTMLInputElement>('input[name="replace"]')?.focus(); return true; } },
                { key: 'F7', run: () => { config.current.onBuild(); return true; } }, indentWithTab]),
            basicSetup, arduinoCpp, cppConstants, theme.current.of(codeTheme(dark)),
            EditorState.changeFilter.of(transaction => {
                if (!transaction.docChanged) return true;
                const text = transaction.newDoc.toString();
                if (text.includes('\0') || new TextEncoder().encode(text).length > 1024 * 1024) {
                    queueMicrotask(() => config.current.onRejectedEdit(uiText('未插入该内容：源码限 1 MiB，且不能包含空字符。', 'Edit rejected: source files are limited to 1 MiB and cannot contain null bytes.'))); return false;
                }
                return true;
            }),
            editable.current.of(EditorState.readOnly.of(readOnly)),
            EditorView.contentAttributes.of({ 'aria-label': uiText('C++ 源码编辑器', 'C++ source code editor'), spellcheck: 'false' }),
            EditorView.theme({ '&': { height: '100%', fontSize: '14px' }, '.cm-scroller': { overflow: 'auto', lineHeight: '1.75', fontFamily: 'Consolas, "Cascadia Code", monospace' },
                '.cm-content': { padding: '16px 0', minHeight: '100%' }, '.cm-line': { padding: '0 20px 0 12px' },
                '.cm-gutters': { border: 'none', backgroundColor: 'transparent', color: '#94a3b8', minWidth: '54px' }, '.cm-lineNumbers .cm-gutterElement': { minWidth: '34px', padding: '0 6px 0 12px' }, '.cm-activeLine': { backgroundColor: 'var(--ck-source-active-line)' }, '&.cm-focused': { outline: 'none' } }),
            EditorView.updateListener.of(update => {
                if (update.docChanged) config.current.onChange(update.state.doc.toString());
                if (update.selectionSet || update.docChanged) { const pos = update.state.selection.main.head, line = update.state.doc.lineAt(pos); config.current.onCursor(line.number, pos - line.from + 1); }
            }),
        ] }) });
        view.current = editor;
        return () => { view.current = null; editor.destroy(); };
        // A different file intentionally gets a separate undo history.
    }, [documentKey]);
    useLayoutEffect(() => { if (active) view.current?.requestMeasure(); }, [active, documentKey]);
    useEffect(() => { const editor = view.current; if (editor && code !== editor.state.doc.toString()) editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: code } }); }, [code]);
    useEffect(() => { view.current?.dispatch({ effects: theme.current.reconfigure(codeTheme(dark)) }); }, [dark]);
    useEffect(() => { view.current?.dispatch({ effects: editable.current.reconfigure(EditorState.readOnly.of(readOnly)) }); }, [readOnly]);
    useEffect(() => {
        const editor = view.current; if (!editor) return;
        editor.dispatch(setDiagnostics(editor.state, diagnostics.filter(d => d.line <= editor.state.doc.lines).map(d => {
            const line = editor.state.doc.line(d.line), from = Math.min(line.to, line.from + d.column - 1);
            return { from, to: Math.min(line.to, from + 1), severity: d.severity, message: d.message };
        })));
    }, [diagnostics, documentKey]);
    useEffect(() => {
        const editor = view.current; if (!editor || !reveal) return;
        const line = editor.state.doc.line(Math.min(editor.state.doc.lines, Math.max(1, reveal.line)));
        const pos = Math.min(line.to, line.from + reveal.column - 1);
        editor.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) }); editor.focus();
    }, [reveal]);
    return <div ref={mount} className="source-code-editor" data-ck-role="source-editor" />;
}
