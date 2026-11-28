import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { Check, Copy, Loader2, Send, X } from 'lucide-react';
import { useUiText } from '../i18n/uiText';

type Preview = { report: Record<string, unknown>; receipt: { reportId: string } | null; submitting: boolean };

export function CompileLogActions({ runId, busy, getLog }: {
    runId: string | null; busy: boolean; getLog: () => string;
}) {
    const { tr } = useUiText();
    const [preview, setPreview] = useState<Preview | null>(null);
    const [pending, setPending] = useState(false);
    const [receipt, setReceipt] = useState('');
    const [notice, setNotice] = useState('');
    const [error, setError] = useState('');
    const activeRun = useRef(runId);
    activeRun.current = runId;
    const dialog = useRef<HTMLDivElement>(null);
    const returnFocus = useRef<HTMLElement | null>(null);
    const inFlight = useRef(false);
    useEffect(() => {
        setPreview(null); setPending(false); setReceipt(''); setNotice(''); setError('');
        inFlight.current = false;
    }, [runId]);
    useEffect(() => {
        if (!preview) return;
        returnFocus.current = document.activeElement as HTMLElement;
        dialog.current?.focus();
        const key = (event: KeyboardEvent) => {
            if (event.key === 'Escape' && !inFlight.current) { event.preventDefault(); setPreview(null); }
            if (event.key === 'Tab') {
                const items = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), textarea') ?? [])];
                const first = items[0], last = items[items.length - 1];
                if (!first) return;
                if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) {
                    event.preventDefault(); last.focus();
                } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) {
                    event.preventDefault(); first.focus();
                }
            }
        };
        document.addEventListener('keydown', key);
        return () => { document.removeEventListener('keydown', key); returnFocus.current?.focus(); };
    }, [Boolean(preview)]);
    const copy = async () => {
        const log = getLog();
        if (!log.trim()) { setNotice(tr('暂无编译日志', 'No build log yet')); return; }
        try { await navigator.clipboard.writeText(log); setNotice(tr('已复制完整输出日志', 'Full build log copied')); setError(''); }
        catch { setError(tr('复制失败，请选中日志后按 Ctrl+C', 'Copy failed; select the log text and press Ctrl+C')); }
    };
    const prepare = async () => {
        if (!runId || busy || inFlight.current) return;
        const run = runId;
        inFlight.current = true; setPending(true); setError(''); setNotice('');
        try {
            const value = await invoke<Preview>('preview_compile_feedback', { runId: run });
            if (activeRun.current !== run) return;
            if (value.receipt) setReceipt(value.receipt.reportId); else setPreview(value);
        } catch (e) { if (activeRun.current === run) setError(String(e)); }
        finally { if (activeRun.current === run) { inFlight.current = false; setPending(false); } }
    };
    const submit = async () => {
        if (!runId || !preview || inFlight.current) return;
        const run = runId;
        inFlight.current = true; setPending(true); setError('');
        try {
            const result = await invoke<{ reportId: string }>('submit_compile_feedback', { runId: run });
            if (activeRun.current !== run) return;
            setReceipt(result.reportId); setPreview(null);
        } catch (e) { if (activeRun.current === run) setError(String(e)); }
        finally { if (activeRun.current === run) { inFlight.current = false; setPending(false); } }
    };
    return <>
        <div data-ck-role="compile-log-actions" className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-slate-200 bg-white px-3 py-1.5 text-xs dark:border-slate-800 dark:bg-slate-900">
            <button type="button" onClick={() => void copy()} className="inline-flex min-h-7 items-center gap-1 rounded px-1.5 text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800" title={tr('复制输出区中的完整日志，不受关键/完整显示模式影响', 'Copy the full build output regardless of compact or verbose display mode')}><Copy size={13} />{tr('复制日志', 'Copy Log')}</button>
            {runId && <button type="button" data-ck-action="submit-compile-log" disabled={busy || pending || !!receipt} onClick={() => void prepare()} className="inline-flex min-h-7 items-center gap-1 rounded px-1.5 text-brand-700 hover:bg-brand-50 disabled:cursor-default disabled:opacity-60 dark:text-brand-300 dark:hover:bg-brand-950">
                {pending ? <Loader2 size={13} className="animate-spin" /> : receipt ? <Check size={13} /> : <Send size={13} />}
                {receipt ? tr('本次已提交', 'Submitted') : busy ? tr('编译结束后可提交', 'Available after build') : pending ? tr('处理中…', 'Working…') : tr('提交本次日志', 'Submit Build Log')}
            </button>}
            <span role={error && !preview ? 'alert' : 'status'} className={`min-w-0 break-all ${error && !preview ? 'text-red-600 dark:text-red-400' : 'text-slate-500 dark:text-slate-400'}`}>
                {error && !preview ? error : receipt ? tr(`报告编号：${receipt}`, `Report ID: ${receipt}`) : notice || (!busy && runId ? tr('编译慢？可脱敏提交给 CK LAB 排查，每次编译仅一份。', 'Slow build? Submit a redacted log to help CK LAB diagnose (one per build).') : '')}
            </span>
        </div>
        {preview && createPortal(<div className="fixed inset-0 z-[1400] flex items-center justify-center bg-black/40 p-4" onMouseDown={e => { if (e.target === e.currentTarget && !pending) setPreview(null); }}>
            <div ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="compile-feedback-title" className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-2xl border border-slate-200 bg-white p-5 shadow-xl outline-none dark:border-slate-700 dark:bg-slate-900">
                <div className="flex items-center justify-between gap-3">
                    <h2 id="compile-feedback-title" className="text-base font-bold text-slate-900 dark:text-slate-100">{tr('提交编译诊断日志', 'Submit Build Diagnostic Log')}</h2>
                    <button type="button" disabled={pending} aria-label={tr('关闭日志预览', 'Close log preview')} onClick={() => setPreview(null)} className="rounded p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40"><X size={18} /></button>
                </div>
                <p className="my-3 text-sm leading-6 text-slate-600 dark:text-slate-300">{tr('仅在点击下方按钮后，将以下内容发送到 CK LAB 服务器供作者排查：版本、板卡配置、任务与耗时日志。不包含工程文件、源码或串口内容；路径、引号内文本及常见密钥字段已过滤。请检查预览，确认没有个人信息。', 'Only after clicking submit below will the redacted preview be sent to CK LAB for diagnostics: app version, board config, task steps, and timing logs. Project files, source code, and serial output are excluded, and paths, quoted strings, and common secrets are filtered. Please review the preview first.')}</p>
                <textarea aria-label={tr('将提交的脱敏日志', 'Redacted log to submit')} readOnly value={JSON.stringify(preview.report, null, 2)} className="min-h-32 flex-1 resize-none rounded-lg border border-slate-200 bg-slate-50 p-3 font-mono text-xs leading-5 text-slate-700 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-300" rows={14} />
                <p className="mt-2 text-xs leading-5 text-slate-500">{tr('每次编译只保存一份，网络中断可重试。日志保留 30 天；匿名安装标识仅用于防刷。提交不影响编译结果。', 'One report is kept per build and can be retried on network errors. Logs are retained for 30 days; an anonymous install ID prevents abuse. Submission never affects build results.')}</p>
                {error && <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
                <div className="mt-4 flex flex-wrap justify-end gap-2">
                    <button type="button" disabled={pending} onClick={() => setPreview(null)} className="rounded-lg border border-slate-200 px-4 py-2 text-sm text-slate-600 dark:border-slate-700 dark:text-slate-300 disabled:opacity-40">{tr('取消', 'Cancel')}</button>
                    <button type="button" data-ck-action="confirm-submit-compile-log" disabled={pending} onClick={() => void submit()} className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-60">
                        {pending && <Loader2 size={15} className="animate-spin" />}{pending ? tr('正在提交…', 'Submitting…') : tr('同意并提交本次日志', 'Agree & Submit Log')}
                    </button>
                </div>
            </div>
        </div>, document.body)}
    </>;
}
