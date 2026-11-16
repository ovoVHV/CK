import React, { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import i18next from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { ProjectOverview } from '../src/components/ProjectOverview';
import { EngineeringHealthView } from '../src/components/EngineeringHealthView';
import { HardwareResourceInspector } from '../src/components/HardwareResourceInspector';
import { ResourcePreflightPanel } from '../src/components/ResourcePreflightPanel';
import { createExperienceFixture } from './product-experience-fixtures';
import enHealth from '../src/locales/en-US/health.json';
import zhHealth from '../src/locales/zh-CN/health.json';
import enBuild from '../src/locales/en-US/build.json';
import zhBuild from '../src/locales/zh-CN/build.json';
import '../src/index.css';

const params = new URLSearchParams(location.search);
const i18n = i18next.createInstance();
await i18n.init({
    lng: params.get('locale') || 'en-US', fallbackLng: 'zh-CN', defaultNS: 'health',
    resources: { 'en-US': { health: enHealth, build: enBuild }, 'zh-CN': { health: zhHealth, build: zhBuild } },
    interpolation: { escapeValue: false },
});
function Preview() {
    const [scenario, setScenario] = useState(params.get('scenario') || 'blink');
    const [mode, setMode] = useState<'simple' | 'engineering'>('simple');
    const [locale, setLocale] = useState(i18n.language);
    const [dark, setDark] = useState(params.get('theme') === 'dark');
    const [located, setLocated] = useState('');
    const [surface, setSurface] = useState(params.get('surface') || 'health');
    const fixture = useMemo(() => createExperienceFixture(scenario), [scenario]);
    const dockWidth = Number(params.get('dock') || 440);
    const unknown = scenario === 'unknown';
    return (
        <I18nextProvider i18n={i18n}>
        <div className={`${dark ? 'dark' : ''} flex h-screen min-w-0 flex-col bg-white text-slate-700 dark:bg-slate-950 dark:text-slate-200`} data-qa-root>
            <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-slate-200 px-4 py-2 text-xs dark:border-slate-700">
                <strong>CK · Component QA</strong>
                <select aria-label="Scenario" value={scenario} onChange={event => setScenario(event.target.value)} className="max-w-full bg-transparent">
                    {['blink', 'shared', 'spi', 'spi-route-gap', 'conflict', 'third-party', 'usb', 'ledc', 'unknown'].map(value => <option key={value}>{value}</option>)}
                </select>
                <select aria-label="Locale" value={locale} onChange={event => { setLocale(event.target.value); void i18n.changeLanguage(event.target.value); document.documentElement.lang = event.target.value; }} className="bg-transparent">
                    <option value="en-US">English</option><option value="zh-CN">简体中文</option>
                </select>
                <select aria-label="Surface" value={surface} onChange={event => setSurface(event.target.value)} className="bg-transparent">
                    <option value="health">Health</option><option value="inspector">Inspector</option><option value="preflight">Preflight</option>
                </select>
                <div role="group" aria-label="View mode" className="flex rounded border border-slate-300 dark:border-slate-700">
                    {(['simple', 'engineering'] as const).map(value => <button key={value} type="button" onClick={() => setMode(value)} aria-pressed={mode === value} className={`px-2 py-1 ${mode === value ? 'bg-teal-100 text-teal-800 dark:bg-teal-950 dark:text-teal-200' : ''}`}>{i18n.t(`view.${value}`)}</button>)}
                </div>
                <label className="flex items-center gap-1"><input type="checkbox" checked={dark} onChange={event => setDark(event.target.checked)} />Dark</label>
                <output aria-label="Located block" className="ml-auto truncate">{located}</output>
            </header>
            <ProjectOverview projectName="Intelligent temperature controller · long-project-name.ck"
                boardName={fixture.identity?.fqbn || (scenario === 'third-party' ? 'Vendor controller with a long board name' : 'QA scenario')}
                compileReport={null} resourceReport={unknown ? null : fixture.report} issues={[]}
                onOpenHealth={() => setSurface('health')} />
            <main className="flex min-h-0 min-w-0 flex-1">
                <div className="min-w-0 flex-1 overflow-auto bg-slate-50 p-5 dark:bg-slate-950">
                    <div className="max-w-2xl text-xs text-slate-500">QA fixtures · Actual CK components · No hardware execution</div>
                    {surface === 'inspector' && <HardwareResourceInspector view={fixture.view} displayMode={mode} onLocateBlock={setLocated} />}
                    {surface === 'preflight' && <ResourcePreflightPanel report={fixture.report} displayMode={mode} onLocateBlock={setLocated} />}
                    {surface === 'health' && <div className="mt-6 max-w-2xl"><HardwareResourceInspector view={unknown ? null : fixture.view} displayMode={mode} onLocateBlock={setLocated} /></div>}
                </div>
                <aside className="min-h-0 min-w-0 shrink-0 border-l border-slate-200 dark:border-slate-700" style={{ width: `min(${dockWidth}px, 44vw)` }}>
                    <EngineeringHealthView compileDoctorReport={null} deviceHealthReport={null} compileResourceReport={null} pinPreflightReport={null}
                        hardwareResourceInspector={unknown ? null : fixture.view} resourcePreflightReport={unknown ? null : fixture.report}
                        compileIssues={[]} fqbn={fixture.identity?.fqbn || ''} configurationFqbn={fixture.identity?.fqbn || ''}
                        configurationSource={unknown || !fixture.identity ? 'unverified' : 'resolved'} coreVersion={fixture.identity?.coreVersion}
                        displayMode={mode} compact onLocateBlock={setLocated} onIssueAction={() => undefined} />
                </aside>
            </main>
        </div>
        </I18nextProvider>
    );
}
createRoot(document.getElementById('root')!).render(<Preview />);
