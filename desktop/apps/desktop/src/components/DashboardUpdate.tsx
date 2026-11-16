import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Download, RefreshCw, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

type Release = { version: string; notes: string; size: number };
type Phase = 'idle' | 'checking' | 'available' | 'downloading' | 'verifying' | 'ready' | 'installing' | 'latest' | 'error';
type Progress = { downloaded: number; total: number; stage: 'downloading' | 'verifying' };
let nextAutomaticCheck = 0;

// This hook and its dialog belong to Dashboard only. Unmount cancels downloads
// and revokes the backend home gate, including late network responses.
export function useDashboardUpdate() {
    const { t } = useTranslation();
    const [version, setVersion] = useState('');
    const [suppressed, setSuppressed] = useState(false);
    const [phase, setPhase] = useState<Phase>('idle');
    const [release, setRelease] = useState<Release | null>(null);
    const [open, setOpen] = useState(false);
    const [error, setError] = useState('');
    const [progress, setProgress] = useState<Progress>({ downloaded: 0, total: 0, stage: 'downloading' });
    const mounted = useRef(false);
    const operation = useRef(false);
    const initialized = useRef<Promise<unknown>>(Promise.resolve());
    const check = async (manual: boolean) => {
        if (operation.current) return;
        operation.current = true;
        if (manual) { setOpen(true); setPhase('checking'); setError(''); }
        try {
            await initialized.current;
            if (!mounted.current) return;
            const found = await invoke<Release | null>('app_update_check', { manual });
            if (!mounted.current) return;
            setRelease(found);
            setPhase(found ? 'available' : 'latest');
            if (found || manual) setOpen(true);
        } catch (e) {
            if (mounted.current && manual) { setError(String(e)); setPhase('error'); }
        } finally { operation.current = false; }
    };
    useEffect(() => {
        mounted.current = true;
        let disposed = false;
        let stop: (() => void) | undefined;
        initialized.current = invoke('app_update_home', { home: true });
        void initialized.current.then(() => invoke<{ currentVersion: string; suppressReminders: boolean }>('app_update_status')).then(status => {
            if (disposed) return;
            setVersion(status.currentVersion); setSuppressed(status.suppressReminders);
            if (!status.suppressReminders && Date.now() >= nextAutomaticCheck) {
                nextAutomaticCheck = Date.now() + 6 * 60 * 60 * 1000;
                void check(false);
            }
        }).catch(() => { /* offline/browser preview: manual check explains errors */ });
        void listen<Progress>('app-update-progress', event => {
            if (!disposed) { setProgress(event.payload); setPhase(event.payload.stage); }
        }).then(unlisten => { if (disposed) unlisten(); else stop = unlisten; }).catch(() => {});
        return () => {
            disposed = true; mounted.current = false; stop?.();
            void invoke('app_update_home', { home: false }).catch(() => {});
        };
    }, []);
    const preference = async (value: boolean) => {
        try { await invoke('app_update_preferences', { suppressReminders: value }); if (mounted.current) setSuppressed(value); }
        catch (e) { if (mounted.current) setError(String(e)); }
    };
    const download = async () => {
        if (operation.current) return;
        operation.current = true; setPhase('downloading'); setError('');
        setProgress({ downloaded: 0, total: release?.size || 0, stage: 'downloading' });
        try { await invoke('app_update_download'); if (mounted.current) setPhase('ready'); }
        catch (e) { if (mounted.current) { setError(String(e)); setPhase('error'); } }
        finally { operation.current = false; }
    };
    const install = async () => {
        if (operation.current) return;
        operation.current = true; setPhase('installing'); setError('');
        try { await invoke('app_update_install'); }
        catch (e) { if (mounted.current) { setError(String(e)); setPhase('ready'); } operation.current = false; }
    };
    const busy = ['downloading', 'verifying', 'installing'].includes(phase);
    const close = () => { if (!busy) setOpen(false); };
    const settings = <section data-ck-role="software-update-settings" className="rounded-xl border border-slate-200 p-4 dark:border-slate-700">
        <h3 className="text-sm font-bold">{t('updates.title')}</h3>
        <div className="mt-2 flex items-center justify-between gap-3">
            <span className="text-xs text-slate-500">{t('updates.current', { version: version || '—' })}</span>
            <button type="button" data-ck-role="check-software-update" onClick={() => void check(true)} disabled={busy || phase === 'checking'} className="rounded-lg bg-brand-600 px-3 py-2 text-xs font-bold text-white disabled:opacity-50">{t('updates.check')}</button>
        </div>
        <label className="mt-3 flex items-center gap-2 text-xs"><input type="checkbox" checked={suppressed} onChange={e => void preference(e.target.checked)} />{t('updates.suppress')}</label>
        <p className="mt-2 text-xs text-slate-500">{t('updates.manualHint')}</p>
    </section>;
    const dialog = open ? <div data-ck-role="software-update-dialog" className="fixed inset-0 z-[11000] flex items-center justify-center bg-slate-950/45 p-5 backdrop-blur-sm">
        <section role="dialog" aria-modal="true" aria-labelledby="software-update-title" className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-6 text-slate-800 shadow-2xl dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100">
            <div className="flex items-center gap-3"><Download className="text-brand-600 dark:text-brand-300" /><h2 id="software-update-title" className="flex-1 text-lg font-bold">{t('updates.title')}</h2><button type="button" disabled={busy} onClick={close} aria-label={t('updates.close')} className="rounded-lg p-2 disabled:opacity-30"><X size={18} /></button></div>
            <p className="mt-3 text-sm text-slate-500">{t('updates.current', { version: version || '—' })}</p>
            {release && <><p className="mt-2 font-semibold">{t('updates.newVersion', { version: release.version })}</p><p className="mt-3 max-h-52 overflow-y-auto whitespace-pre-wrap text-sm leading-6">{release.notes}</p></>}
            {phase === 'checking' && <p className="mt-5 flex items-center gap-2"><RefreshCw size={16} className="animate-spin" />{t('updates.checking')}</p>}
            {phase === 'latest' && <p className="mt-5">{t('updates.latest')}</p>}
            {busy && <div className="mt-5" role="status" aria-live="polite"><p className="text-sm">{t(phase === 'installing' ? 'updates.installing' : phase === 'verifying' ? 'updates.verifying' : 'updates.downloading')}</p>{phase !== 'installing' && <><progress className="mt-3 h-2 w-full accent-brand-600" max={Math.max(1, progress.total)} value={progress.downloaded} /><p className="mt-1 text-right text-xs text-slate-500">{(progress.downloaded / 1048576).toFixed(1)} / {(progress.total / 1048576).toFixed(1)} MB</p></>}</div>}
            {phase === 'ready' && <p className="mt-5 text-sm text-brand-700 dark:text-brand-300">{t('updates.ready')}</p>}
            {error && <p className="mt-4 max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-sm text-red-600" role="alert">{error}</p>}
            {!busy && <label className="mt-5 flex items-center gap-2 text-xs"><input data-ck-role="suppress-update-reminders" type="checkbox" checked={suppressed} onChange={e => void preference(e.target.checked)} />{t('updates.suppress')}</label>}
            <div className="mt-6 flex justify-end gap-3">
                {['downloading', 'verifying'].includes(phase) && <button type="button" onClick={() => void invoke('app_update_cancel')} className="rounded-lg border px-4 py-2 text-sm">{t('updates.cancel')}</button>}
                {!busy && <button type="button" onClick={close} className="rounded-lg border border-slate-200 px-4 py-2 text-sm dark:border-slate-700">{t('updates.later')}</button>}
                {release && ['available', 'error'].includes(phase) && <button type="button" data-ck-role="download-software-update" onClick={() => void download()} className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-bold text-white">{t('updates.download')}</button>}
                {phase === 'error' && !release && <button type="button" onClick={() => void check(true)} className="rounded-lg bg-brand-600 px-4 py-2 text-sm text-white">{t('updates.retry')}</button>}
                {phase === 'ready' && <button type="button" data-ck-role="install-software-update" onClick={() => void install()} className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-bold text-white">{t('updates.install')}</button>}
            </div>
        </section>
    </div> : null;
    return { settings, dialog };
}
