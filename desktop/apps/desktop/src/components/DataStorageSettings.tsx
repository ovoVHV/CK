import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { FolderOpen, HardDrive, LoaderCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

type Storage = { root: string; assets: string; temp: string; desktop: string; projects: string; externalAssets: boolean; previousRoots?: string[] };
type Plan = { target: string; bytes: number; files: number; available: number; includeExternal: boolean };
export default function DataStorageSettings() {
    const { t } = useTranslation();
    const [storage, setStorage] = useState<Storage | null>(null);
    const [target, setTarget] = useState('');
    const [includeExternal, setIncludeExternal] = useState(false);
    const [plan, setPlan] = useState<Plan | null>(null);
    const [busy, setBusy] = useState(false);
    const [restarting, setRestarting] = useState(false);
    const [error, setError] = useState('');
    useEffect(() => { let active = true; void invoke<Storage>('app_storage_status').then(s => { if (active) setStorage(s); }).catch(e => { if (active) setError(String(e)); }); return () => { active = false; }; }, []);
    const choose = async () => {
        try { const p = await open({ directory: true, multiple: false, title: t('storage.choose') }); if (typeof p === 'string') { setTarget(p); setPlan(null); } }
        catch (e) { setError(String(e)); }
    };
    const inspect = async () => {
        setBusy(true); setError(''); setPlan(null);
        try { setPlan(await invoke<Plan>('app_storage_plan', { target, includeExternal })); } catch (e) { setError(String(e)); } finally { setBusy(false); }
    };
    const migrate = async () => {
        if (!plan) return; setBusy(true); setError('');
        try { await invoke('app_storage_schedule', { target: plan.target, includeExternal: plan.includeExternal }); setRestarting(true); }
        catch (e) { setError(String(e)); setBusy(false); }
    };
    const gb = (n: number) => (n / 1073741824).toFixed(2);
    return <section data-ck-role="data-storage-settings" className="rounded-xl border border-slate-200 p-4 dark:border-slate-700">
        <h3 className="flex items-center gap-2 text-sm font-bold"><HardDrive size={17} />{t('storage.title')}</h3>
        <p className="mt-2 text-xs text-slate-500">{t('storage.description')}</p>
        {storage && <>
            <dl className="mt-3 space-y-2 text-xs">
                {([['storage.current', storage.root], ['storage.assets', storage.assets], ['storage.build', storage.temp], ['storage.projects', storage.projects]] as const).map(([label, value]) => <div key={label}><dt className="text-slate-500">{t(label)}</dt><dd className="mt-0.5 break-all font-mono select-text">{value}</dd></div>)}
            </dl>
            <label className="mt-4 block text-xs font-semibold" htmlFor="ck-data-target">{t('storage.destination')}</label>
            <div className="mt-2 flex gap-2"><input id="ck-data-target" data-ck-role="data-storage-target" disabled={busy} value={target} onChange={e => { setTarget(e.target.value); setPlan(null); }} placeholder="D:\CKData" className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-transparent px-3 py-2 text-xs dark:border-slate-600" /><button type="button" disabled={busy} onClick={() => void choose()} className="rounded-lg border px-3 py-2 text-xs"><FolderOpen size={16} /><span className="sr-only">{t('storage.choose')}</span></button></div>
            {storage.externalAssets && <label className="mt-3 flex items-start gap-2 text-xs"><input className="mt-0.5" type="checkbox" disabled={busy} checked={includeExternal} onChange={e => { setIncludeExternal(e.target.checked); setPlan(null); }} /><span>{t('storage.includeExternal')}<span className="mt-1 block text-slate-500">{t('storage.externalHint')}</span></span></label>}
            <p className="mt-3 text-xs leading-5 text-slate-500">{t('storage.migrationHint')}</p>
            {plan ? <div className="mt-3 rounded-lg bg-brand-50 p-3 dark:bg-brand-950"><p className="text-xs">{t('storage.plan', { files: plan.files, size: gb(plan.bytes), available: gb(plan.available) })}</p><button data-ck-role="data-storage-migrate" type="button" disabled={busy} onClick={() => void migrate()} className="mt-3 rounded-lg bg-brand-600 px-3 py-2 text-xs font-bold text-white disabled:opacity-50">{t('storage.restart')}</button></div> : <button data-ck-role="data-storage-plan" type="button" disabled={busy || !target.trim()} onClick={() => void inspect()} className="mt-3 inline-flex items-center gap-2 rounded-lg bg-brand-600 px-3 py-2 text-xs font-bold text-white disabled:opacity-50">{busy && <LoaderCircle size={14} className="animate-spin" />}{t('storage.inspect')}</button>}
            {!!storage.previousRoots?.length && <p className="mt-3 break-all text-xs text-slate-500">{t('storage.previous')} {Array.from(new Set(storage.previousRoots)).join('；')}</p>}
        </>}
        {error && <p role="alert" className="mt-3 break-all text-xs text-red-600 dark:text-red-300">{error}</p>}
        {restarting && <p role="status" className="mt-3 text-sm font-semibold">{t('storage.restarting')}</p>}
    </section>;
}
