// Development-only component harness: load the real gate's exported report.
// Not an application route and not included in the production web bundle.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import i18next from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { ResourcePreflightPanel } from '../src/components/ResourcePreflightPanel';
import { HardwareResourceInspector } from '../src/components/HardwareResourceInspector';
import type { ImplementationCheckStatus, ResourcePreflightEvaluation } from '../src/services/resource_preflight';
import en from '../src/locales/en-US/health.json';
import zh from '../src/locales/zh-CN/health.json';
import '../src/index.css';

const params = new URLSearchParams(location.search);
const evidence = params.get('evidence') || '';
if (!evidence.startsWith('/@fs/') || !evidence.endsWith('/runtime-presentation.json')) {
    throw new Error('Specify the local real-compiler gate runtime-presentation.json via the evidence query.');
}
const response = await fetch(evidence);
if (!response.ok) throw new Error(`Evidence unavailable: ${response.status}`);
const result = await response.json() as ResourcePreflightEvaluation;
const i18n = i18next.createInstance();
await i18n.init({ lng: params.get('locale') || 'en-US', fallbackLng: 'zh-CN', defaultNS: 'health',
    resources: { 'en-US': { health: en }, 'zh-CN': { health: zh } }, interpolation: { escapeValue: false } });
function Preview() {
    const [locale, setLocale] = useState(i18n.language);
    const [dark, setDark] = useState(params.get('theme') === 'dark');
    const [located, setLocated] = useState('');
    const [checkStatus, setCheckStatus] = useState<ImplementationCheckStatus>(result.report.implementationCheck || 'partial');
    const [buildClicks, setBuildClicks] = useState(0);
    return <I18nextProvider i18n={i18n}>
        <main className={`${dark ? 'dark' : ''} min-h-screen bg-white text-slate-800 dark:bg-slate-950 dark:text-slate-100`}>
            <header className="sticky top-0 z-10 flex flex-wrap items-center gap-4 border-b bg-white p-3 text-sm dark:bg-slate-950">
                <strong>Real compiler report · Component QA · No physical hardware test</strong>
                <select aria-label="Locale" value={locale} onChange={event => {
                    setLocale(event.target.value); document.documentElement.lang = event.target.value;
                    void i18n.changeLanguage(event.target.value);
                }} className="bg-transparent"><option value="en-US">English</option><option value="zh-CN">简体中文</option></select>
                <label><input type="checkbox" checked={dark} onChange={event => setDark(event.target.checked)} /> Dark</label>
                <output aria-label="Located block">{located || 'No block located'}</output>
                <select aria-label="Implementation lifecycle" value={checkStatus}
                    onChange={event => setCheckStatus(event.target.value as ImplementationCheckStatus)} className="bg-transparent">
                    {['needs-compile', 'running', 'partial', 'unavailable', 'stale'].map(state => <option key={state} value={state}>{state}</option>)}
                </select>
                <output aria-label="Build callback">Test-only build callback: {buildClicks}</output>
            </header>
            <div className="mx-auto grid min-w-0 max-w-7xl gap-4 p-4 lg:grid-cols-2">
                <ResourcePreflightPanel report={{ ...result.report, implementationCheck: checkStatus }} displayMode="simple"
                    onLocateBlock={setLocated} onCompileForResources={() => setBuildClicks(value => value + 1)} />
                <HardwareResourceInspector view={result.inspector} displayMode="simple" onLocateBlock={setLocated} />
            </div>
        </main>
    </I18nextProvider>;
}
createRoot(document.getElementById('root')!).render(<Preview />);
