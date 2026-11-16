// Development-only UI regression host. No native IPC or user projects.
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import * as Blockly from 'blockly';
import { ThemeProvider, useAppTheme } from '../src/contexts/ThemeContext';
import { initializeI18n } from '../src/i18n';
import AppearanceSettingsModal from '../src/components/AppearanceSettingsModal';
import { BlockDock } from '../src/components/BlockDock';
import { getBlocklyVisualTheme } from '../src/theme/blockly_visual_themes';
import '../src/index.css';

await initializeI18n();
Blockly.defineBlocksWithJsonArray([
    { type: 'qa_ui_output', message0: 'Digital output %1', args0: [{ type: 'field_number', name: 'PIN', value: 13 }],
        colour: 185, previousStatement: null, nextStatement: null },
]);
window.CK_BLOCK_CATALOG = { schemaVersion: 2, board: 'QA', generatedAt: '', blockCount: 1, blocks: [
    { type: 'qa_ui_output', display_name: 'Digital output', category: 'Logic', category_id: 'logic',
        keywords: ['output', 'GPIO'], source: 'toolbox' },
] };

function Regression() {
    const host = useRef<HTMLDivElement>(null);
    const [workspace, setWorkspace] = useState<Blockly.WorkspaceSvg | null>(null);
    const [sidebar, setSidebar] = useState(false);
    const [settings, setSettings] = useState(false);
    const [identity, setIdentity] = useState('');
    const { resolvedTheme, setThemeMode } = useAppTheme();
    const theme = getBlocklyVisualTheme('original', resolvedTheme);
    useEffect(() => {
        const ws = Blockly.inject(host.current!, {
            renderer: 'thrasos', theme, scrollbars: true, sounds: false,
            toolbox: { kind: 'categoryToolbox', contents: [
                { kind: 'category', name: 'GPIO', contents: [{ kind: 'block', type: 'qa_ui_output' }] },
                { kind: 'category', name: 'Logic', contents: [{ kind: 'block', type: 'qa_ui_output' }] },
            ] },
        });
        const block = ws.newBlock('qa_ui_output', 'ui-regression-stable-block');
        block.initSvg(); block.render(); block.moveBy(240, 100);
        const initial = JSON.stringify(Blockly.serialization.workspaces.save(ws));
        const report = () => setIdentity(JSON.stringify(Blockly.serialization.workspaces.save(ws)) === initial ? 'unchanged' : 'changed');
        ws.addChangeListener(report);
        let frame = 0;
        // Match Workspace's deferred SVG resize: this is the stale-metrics case.
        const observer = new ResizeObserver(() => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => { Blockly.svgResize(ws); report(); });
        });
        observer.observe(host.current!);
        setWorkspace(ws); report();
        return () => { observer.disconnect(); cancelAnimationFrame(frame); ws.dispose(); };
    }, []);
    useEffect(() => { workspace?.setTheme(theme); }, [workspace, theme]);
    return <main className="flex h-screen min-w-0 flex-col bg-white text-slate-800 dark:bg-slate-950 dark:text-slate-100">
        <header className="flex flex-wrap gap-3 border-b border-slate-300 p-3 text-sm">
            <button onClick={() => setSidebar(value => !value)}>Toggle sidebar</button>
            <button onClick={() => setSettings(true)}>Appearance</button>
            <button onClick={() => setThemeMode(resolvedTheme === 'dark' ? 'light' : 'dark')}>Toggle theme</button>
            <output data-qa-identity>{identity}</output>
        </header>
        <div className="flex min-h-0 min-w-0 flex-1">
            <div className="ck-workspace-stage relative min-h-0 min-w-0 flex-1 overflow-hidden">
                <div ref={host} className="absolute inset-0" data-qa-workspace />
                <BlockDock workspace={workspace} renderer="thrasos" theme={theme} visualStyle="original" />
            </div>
            {sidebar && <aside className="w-[38%] shrink-0 border-l border-slate-300 p-4">Sidebar</aside>}
        </div>
        <AppearanceSettingsModal isOpen={settings} onClose={() => setSettings(false)}
            blocklyVisualStyle="original" onBlocklyVisualStyleChange={() => {}} />
    </main>;
}
createRoot(document.getElementById('root')!).render(<ThemeProvider><Regression /></ThemeProvider>);
