/** Browser-only fixture host. Not imported by CK's production entry. No real IPC. */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import i18next from 'i18next';
import { I18nextProvider } from 'react-i18next';
import * as Blockly from 'blockly';
import { resources } from '../src/i18n/resources';
import { ThemeProvider, useAppTheme } from '../src/contexts/ThemeContext';
import { DialogProvider } from '../src/contexts/DialogContext';
import { HardwareProvider } from '../src/contexts/HardwareContext';
import Dashboard from '../src/components/Dashboard';
import { ProjectOverview } from '../src/components/ProjectOverview';
import { EngineeringHealthView } from '../src/components/EngineeringHealthView';
import { BlockDock } from '../src/components/BlockDock';
import { publishProjectStatus } from '../src/components/project_status_session';
import { analyzeCompileIssues } from '../src/services/compile_issue_cards';
import { getBlocklyVisualTheme } from '../src/theme/blockly_visual_themes';
import { applyBlocklyVisualSkin } from '../src/services/blockly_visual_skin';
import type { BlockSearchEntry } from '../src/types/library';
import { createExperienceFixture } from './product-experience-fixtures';
import '../src/index.css';

const params = new URLSearchParams(location.search);
const i18n = i18next.createInstance();
await i18n.init({ lng: params.get('locale') || 'en-US', fallbackLng: 'zh-CN', defaultNS: 'common', resources, interpolation: { escapeValue: false } });
const projectName = 'Thermal controller — long-project-name-with-multiple-sensors.ck';
const projectPath = 'C:/QA projects/用户工程/' + projectName;
// Whitelisted read-only fixture IPC; all other commands reject, never delegate.
(window as any).__TAURI_INTERNALS__ = {
    invoke: async (command: string) => {
        if (command === 'list_projects') return [{ name: projectName, path: projectPath, board: 'vendor:chip:long-board-identity', last_modified: '2026-09-23 21:00' }];
        if (['get_all_libraries', 'get_installed_cores', 'get_custom_boards_v2', 'list_serial_ports'].includes(command)) return [];
        if (command === 'plugin:fs|exists') return true;
        if (command.startsWith('plugin:path|')) return 'C:/QA';
        throw new Error(`QA deliberately blocks IPC: ${command}`);
    },
    transformCallback: () => 1,
    unregisterCallback: () => {},
};
const entries: BlockSearchEntry[] = [
    { type: 'qa_aht20', display_name: 'AHT20 temperature and humidity', category: 'QA Sensors', category_id: 'qa-sensors', keywords: ['temperature', 'humidity', 'AHT20'], source: 'manifest',
        hardware: { resources: [{ kind: 'i2c', description: 'I2C' }], boards: ['vendor:chip:board'], architectures: ['QA MCU'] },
        dependencies: [{ kind: 'arduino-library', id: 'Vendor Sensor Library With A Long Name' }] },
    { type: 'qa_oled', display_name: 'OLED display', category: 'QA Displays', category_id: 'qa-displays', keywords: ['OLED', 'display'], source: 'manifest',
        hardware: { resources: [{ kind: 'i2c', description: 'I2C' }] } },
    { type: 'qa_legacy', display_name: 'Legacy temperature module', category: 'QA Sensors', category_id: 'qa-sensors', keywords: ['temperature'], source: 'toolbox' },
];
Blockly.defineBlocksWithJsonArray(entries.map((entry, index) => ({
    type: entry.type, message0: entry.display_name,
    previousStatement: null, nextStatement: null, colour: [185, 225, 45][index],
})));
window.CK_BLOCK_CATALOG = { schemaVersion: 2, board: 'QA only', generatedAt: '', blockCount: entries.length, blocks: entries };

function EditorSurface({ scenario, onAction }: { scenario: string; onAction: (value: string) => void }) {
    const { resolvedTheme } = useAppTheme();
    const theme = getBlocklyVisualTheme('original', resolvedTheme);
    const host = useRef<HTMLDivElement>(null);
    const [workspace, setWorkspace] = useState<Blockly.WorkspaceSvg | null>(null);
    const [blockCount, setBlockCount] = useState(0);
    const fixture = useMemo(() => createExperienceFixture(scenario), [scenario]);
    const unknown = scenario === 'unknown';
    const issues = useMemo(() => analyzeCompileIssues({ log: 'C:\\QA projects\\用户工程\\main.ino:10:1: fatal error: VendorSensor.h: No such file or directory' }), []);
    useEffect(() => {
        const ws = Blockly.inject(host.current!, { renderer: 'thrasos', theme, scrollbars: true, sounds: false });
        const onChange = () => setBlockCount(ws.getAllBlocks(false).length);
        ws.addChangeListener(onChange);
        const observer = new ResizeObserver(() => Blockly.svgResize(ws));
        observer.observe(host.current!);
        setWorkspace(ws);
        return () => { observer.disconnect(); ws.removeChangeListener(onChange); ws.dispose(); };
    }, []);
    useEffect(() => {
        if (!workspace) return;
        workspace.setTheme(theme);
        applyBlocklyVisualSkin(workspace, 'original');
    }, [workspace, theme]);
    return <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <ProjectOverview projectName={projectName} boardName={fixture.identity?.fqbn || 'Third-party QA board'}
            compileReport={null} resourceReport={unknown ? null : fixture.report} issues={issues} onOpenHealth={() => onAction('project-check')} />
        <div className="flex min-h-0 min-w-0 flex-1">
            <div className="ck-workspace-stage relative min-h-0 min-w-0 flex-1 overflow-hidden">
                <div ref={host} className="absolute inset-0" />
                <output data-qa-block-count className="absolute left-3 top-3 rounded bg-white p-2 text-xs text-slate-600">Inserted blocks: {blockCount}</output>
                <BlockDock workspace={workspace} renderer="thrasos" theme={theme} visualStyle="original"
                    resourceView={unknown ? null : fixture.view} onNotice={onAction} />
            </div>
            <aside className="min-h-0 min-w-0 w-[min(350px,38vw)] shrink-0 overflow-hidden border-l border-slate-300">
                <EngineeringHealthView compileDoctorReport={null} deviceHealthReport={null} compileResourceReport={null} pinPreflightReport={null}
                    hardwareResourceInspector={unknown ? null : fixture.view} resourcePreflightReport={unknown ? null : fixture.report}
                    compileIssues={issues} fqbn={fixture.identity?.fqbn || ''} configurationFqbn={fixture.identity?.fqbn || ''}
                    configurationSource={unknown ? 'unverified' : 'resolved'} displayMode="simple" compact
                    onLocateBlock={id => onAction(`locate:${id}`)} onIssueAction={action => onAction(action.kind)}
                    onOpenLibraries={() => onAction('libraries')} onOpenCheckpoints={() => onAction('checkpoints')} onOpenLastWorking={() => onAction('last-working')} />
            </aside>
        </div>
    </div>;
}
function Preview() {
    const [surface, setSurface] = useState(params.get('surface') || 'home');
    const [scenario, setScenario] = useState(params.get('scenario') || 'shared');
    const [locale, setLocale] = useState(i18n.language);
    const [action, setAction] = useState('');
    const { setThemeMode, resolvedTheme } = useAppTheme();
    useEffect(() => {
        setThemeMode(params.get('theme') === 'dark' ? 'dark' : 'light');
        const fixture = createExperienceFixture('shared');
        publishProjectStatus(projectPath, { compileReport: null, resourceReport: fixture.report, issues: [], dirty: false, observedAt: Date.now() });
    }, []);
    return <div className="flex h-screen min-w-0 flex-col bg-white text-slate-800 dark:bg-slate-950 dark:text-slate-200">
        <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-slate-300 px-3 py-2 text-xs">
            <strong>CK v2 · QA fixtures / mock IPC</strong>
            <select aria-label="Surface" className="bg-transparent" value={surface} onChange={event => setSurface(event.target.value)}><option value="home">Home</option><option value="workspace">Workspace</option></select>
            <select aria-label="Scenario" className="bg-transparent" value={scenario} onChange={event => setScenario(event.target.value)}>
                {['shared', 'conflict', 'third-party', 'unknown', 'usb', 'ledc'].map(value => <option key={value}>{value}</option>)}
            </select>
            <select aria-label="Locale" className="bg-transparent" value={locale} onChange={event => { setLocale(event.target.value); void i18n.changeLanguage(event.target.value); document.documentElement.lang = event.target.value; }}>
                <option value="en-US">English</option><option value="zh-CN">简体中文</option>
            </select>
            <label><input type="checkbox" checked={resolvedTheme === 'dark'} onChange={event => setThemeMode(event.target.checked ? 'dark' : 'light')} />Dark</label>
            <output aria-label="Last action" className="min-w-0 max-w-72 truncate">{action}</output>
        </header>
        {surface === 'home'
            ? <div className="min-h-0 min-w-0 flex-1 overflow-auto"><Dashboard onNewProject={() => setAction('new')} onOpenProject={(_path, options) => { setAction(options?.openCheck ? 'open-check' : 'open'); setSurface('workspace'); }} /></div>
            : <EditorSurface scenario={scenario} onAction={setAction} />}
    </div>;
}
createRoot(document.getElementById('root')!).render(
    <I18nextProvider i18n={i18n}><ThemeProvider><DialogProvider><HardwareProvider><Preview /></HardwareProvider></DialogProvider></ThemeProvider></I18nextProvider>,
);
