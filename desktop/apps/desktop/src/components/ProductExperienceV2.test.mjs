import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import i18next from 'i18next';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);
const { I18nextProvider } = require('react-i18next');
const bundle = await build({
    stdin: { contents: `
        export { DashboardProjectStatus } from './DashboardProjectStatus';
        export { ProjectOverview } from './ProjectOverview';
        export { BlockDiscoveryDetails } from './BlockDiscoveryDetails';
        export { describeBlockDiscovery } from './block_discovery_presentation';
        export { publishProjectStatus, readProjectStatus, readRecentProjectPath } from './project_status_session';
        export { ProjectCheckNavigation, ProjectRecoveryLinks } from './ProjectCheckNavigation';
        export { BuildIssueCards } from './BuildIssueCards';
        export { searchBlockDockEntries } from '../services/block_dock';
        export { analyzeCompileIssues } from '../services/compile_issue_cards';
        export { createExperienceFixture } from '../../qa/product-experience-fixtures';
    `, resolveDir: fileURLToPath(new URL('.', import.meta.url)), loader: 'tsx' },
    bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false, jsx: 'automatic',
});
const module = { exports: {} };
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(require, module, module.exports);
const api = module.exports;
const resources = {};
for (const locale of ['en-US', 'zh-CN']) {
    resources[locale] = {};
    for (const ns of ['health', 'build', 'editor']) resources[locale][ns] = JSON.parse(await readFile(new URL(`../locales/${locale}/${ns}.json`, import.meta.url), 'utf8'));
}
const i18n = i18next.createInstance();
await i18n.init({ lng: 'en-US', fallbackLng: 'zh-CN', resources, interpolation: { escapeValue: false } });
const provide = element => React.createElement(I18nextProvider, { i18n }, element);
const render = (Component, props) => new JSDOM(renderToStaticMarkup(provide(React.createElement(Component, props)))).window.document;
const freeze = value => {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    Object.values(value).forEach(freeze); return Object.freeze(value);
};
const entry = freeze({
    type: 'vendor_thermometer', display_name: 'Read temperature', category_id: 'vendor-sensor',
    description: 'Read humidity from the sensor', keywords: ['AHT20'], source: 'manifest', library_id: 'vendor-thermometer',
    hardware: { resources: [{ kind: 'i2c', description: 'Bus' }], boards: ['vendor:chip:board'], architectures: ['vendor-mcu'] },
    dependencies: [{ kind: 'arduino-library', id: 'Vendor Sensor' }],
});
async function mount(Component, props, run) {
    const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
    const old = { window: globalThis.window, document: globalThis.document, flag: globalThis.IS_REACT_ACT_ENVIRONMENT };
    globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const root = createRoot(document.getElementById('root'));
    try {
        await act(async () => root.render(provide(React.createElement(Component, props))));
        await run(dom.window.document, dom.window);
    } finally {
        await act(async () => root.unmount());
        globalThis.window = old.window; globalThis.document = old.document; globalThis.IS_REACT_ACT_ENVIRONMENT = old.flag;
        dom.window.close();
        await i18n.changeLanguage('en-US');
    }
}

test('search matches name, function, hardware kind, bilingual keyword and dependency without changing catalog identity', () => {
    const before = JSON.stringify(entry);
    for (const query of ['AHT20', '温度', '湿度', 'temperature', 'I2C', 'Vendor Sensor', 'vendor-mcu']) {
        assert.equal(api.searchBlockDockEntries([entry], { query })[0], entry, query);
    }
    assert.equal(api.searchBlockDockEntries([entry], { query: 'missing capability' }).length, 0);
    assert.equal(JSON.stringify(entry), before);
});
test('unknown resolved board never gets a compatibility or pin allocation claim', () => {
    const model = api.describeBlockDiscovery(entry, null);
    assert.equal(model.context, 'unresolved');
    assert.deepEqual(model.controllers, []);
    const text = render(api.BlockDiscoveryDetails, { entry }).body.textContent;
    assert.match(text, /await resolution/);
    assert.doesNotMatch(text, /ready to use|guaranteed|GPIO\d+/i);
});
test('third-party graph uses the same discovery projection; bus capability is not binding', () => {
    const view = freeze(api.createExperienceFixture('shared').view);
    const before = JSON.stringify(view);
    const detail = api.describeBlockDiscovery(entry, view);
    assert.ok(detail.controllers.includes('i2c0'));
    assert.deepEqual(detail.boards, ['vendor:chip:board']);
    const text = render(api.BlockDiscoveryDetails, { entry, view }).body.textContent;
    assert.match(text, /not a binding or compatibility guarantee/);
    assert.match(text, /no pins are assigned automatically/);
    assert.equal(JSON.stringify(view), before);
});
test('missing declarations remain unknown even when an OLED keyword is searchable', () => {
    const legacy = { type: 'legacy_oled', keywords: ['OLED'], source: 'toolbox' };
    const detail = api.describeBlockDiscovery(legacy, api.createExperienceFixture('third-party').view);
    assert.equal(detail.context, 'undeclared');
    assert.deepEqual(detail.resources, []);
    assert.deepEqual(detail.controllers, []);
    assert.equal(api.searchBlockDockEntries([legacy], { query: '显示' })[0], legacy);
});
test('USB Serial/JTAG is never presented as an available UART controller', () => {
    const view = api.createExperienceFixture('usb').view;
    const uartEntry = { ...entry, hardware: { resources: [{ kind: 'uart', description: '' }] } };
    const detail = api.describeBlockDiscovery(uartEntry, view);
    assert.deepEqual(detail.controllers, view.uarts.map(item => item.id));
    for (const usb of view.usbSerialJtag) assert.ok(!detail.controllers.includes(usb.id));
});
test('Dashboard starts unknown rather than inventing healthy historical project results', () => {
    const doc = render(api.DashboardProjectStatus, { path: 'unknown.ck', name: '用户工程', board: 'Vendor Board', onOpenCheck() {} });
    assert.match(doc.body.textContent, /No check results/);
    assert.equal(doc.querySelector('[data-ck-role="project-build-status"]').dataset.status, 'unknown');
    assert.equal(doc.querySelector('[data-ck-role="project-resource-status"]').dataset.status, 'unavailable');
});
test('session summary is path-scoped, historical, hot-switchable and opens only the selected project check', async () => {
    const snapshot = freeze({ compileReport: { success: true }, resourceReport: api.createExperienceFixture('shared').report, issues: [], dirty: true, observedAt: 1 });
    const before = JSON.stringify(snapshot);
    let opens = 0;
    await mount(api.DashboardProjectStatus, { path: 'A.ck', name: '用户工程.ck', board: 'Vendor Board', onOpenCheck: () => opens++ }, async doc => {
        await act(async () => api.publishProjectStatus('B.ck', snapshot));
        assert.match(doc.body.textContent, /No check results/);
        await act(async () => api.publishProjectStatus('A.ck', snapshot));
        assert.match(doc.body.textContent, /Last build/);
        assert.match(doc.body.textContent, /Historical results/);
        assert.match(doc.body.textContent, /project has changed/);
        await act(async () => i18n.changeLanguage('zh-CN'));
        assert.match(doc.body.textContent, /工程检查/);
        assert.doesNotMatch(doc.body.textContent, /Last build|Historical results/);
        await act(async () => doc.querySelector('[data-ck-role="project-resource-status"]').click());
        assert.equal(opens, 1);
    });
    assert.equal(JSON.stringify(snapshot), before);
    assert.equal(api.readProjectStatus('A.ck'), snapshot);
});
test('session history is bounded and never writes browser persistence', async () => {
    await mount(api.DashboardProjectStatus, { path: 'cache-19', name: 'Test', board: '', onOpenCheck() {} }, async (_doc, win) => {
        await act(async () => {
            for (let index = 0; index < 20; index++) api.publishProjectStatus(`cache-${index}`, { compileReport: null, resourceReport: null, issues: [], dirty: false, observedAt: index });
        });
        assert.equal(api.readProjectStatus('cache-0'), null);
        assert.ok(api.readProjectStatus('cache-19'));
        assert.equal(api.readRecentProjectPath(), 'cache-19');
        assert.equal(win.localStorage.length, 0);
        assert.equal(win.sessionStorage.length, 0);
    });
});
test('project check navigation and recovery links invoke only existing UI callbacks', async () => {
    const sections = [];
    await mount(api.ProjectCheckNavigation, { onSelect: value => sections.push(value) }, async doc => {
        for (const button of doc.querySelectorAll('button')) await act(async () => button.click());
        assert.deepEqual(sections, ['compile', 'hardware', 'resources', 'recovery', 'dependencies']);
    });
    const actions = [];
    await mount(api.ProjectRecoveryLinks, { onOpenCheckpoints: () => actions.push('checkpoint'), onOpenLastWorking: () => actions.push('last-working') }, async doc => {
        for (const button of doc.querySelectorAll('button')) await act(async () => button.click());
    });
    assert.deepEqual(actions, ['checkpoint', 'last-working']);
});
test('missing dependency explains impact first, preserves exact raw evidence, and does not silently install', async () => {
    const raw = 'C:\\用户工程\\long path\\main.ino:1:10: fatal error: VendorSensor.h: No such file or directory';
    const issues = freeze(api.analyzeCompileIssues({ log: raw }));
    assert.ok(issues.length);
    let action;
    await mount(api.BuildIssueCards, { issues, onAction: value => { action = value; }, onLocateBlock() {} }, async doc => {
        const evidence = doc.querySelector('[data-ck-role="build-issue-raw-evidence"]');
        assert.equal(evidence.open, false);
        assert.equal(evidence.querySelector('code').textContent, raw);
        assert.match(doc.querySelector('[data-ck-role="missing-dependency-impact"]').textContent, /cannot be built/);
        const button = doc.querySelector('button');
        assert.ok(button.compareDocumentPosition(evidence) & 4, 'remediation precedes raw evidence');
        await act(async () => button.click());
        assert.equal(action, issues[0].action);
        assert.equal(action.kind, 'library_search');
        await act(async () => i18n.changeLanguage('zh-CN'));
        assert.equal(evidence.querySelector('code').textContent, raw);
    });
});
test('new UI copy has key parity and interpolation parity', () => {
    const flatten = (object, prefix = '') => Object.entries(object).flatMap(([key, value]) => typeof value === 'string' ? [[`${prefix}${key}`, value]] : flatten(value, `${prefix}${key}.`));
    for (const [ns, root] of [['health', 'productV2'], ['editor', 'discovery'], ['build', 'productV2']]) {
        const en = new Map(flatten(resources['en-US'][ns][root]));
        const zh = new Map(flatten(resources['zh-CN'][ns][root]));
        assert.deepEqual([...en.keys()].sort(), [...zh.keys()].sort());
        for (const [key, value] of en) assert.deepEqual(value.match(/\{\{[^}]+\}\}/g), zh.get(key).match(/\{\{[^}]+\}\}/g));
    }
});

test('workspace and search keep technical summaries out of the editing surface', async () => {
    const workspace = await readFile(new URL('Workspace.tsx', import.meta.url), 'utf8');
    const dock = await readFile(new URL('BlockDock.tsx', import.meta.url), 'utf8');
    const health = await readFile(new URL('EngineeringHealthView.tsx', import.meta.url), 'utf8');
    const styles = await readFile(new URL('../index.css', import.meta.url), 'utf8');
    assert.doesNotMatch(workspace, /<ProjectOverview\b/);
    assert.match(workspace, /data-ck-role="engineering-health-button"/);
    assert.match(workspace, /isProjectDirty/);
    assert.doesNotMatch(dock, /BlockDiscoveryDetails|selected-block-details/);
    assert.doesNotMatch(styles, /\.ck-block-dock-selected-details/);
    assert.match(health, /<ProjectOverview\b/);
    assert.match(health, /<HardwareResourceInspector\b/);
});
