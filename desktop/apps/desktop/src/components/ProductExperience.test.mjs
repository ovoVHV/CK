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
const bundled = await build({
    stdin: { contents: `
        export { ProjectOverview } from './ProjectOverview';
        export { HardwareResourceInspector } from './HardwareResourceInspector';
        export { ResourcePreflightPanel } from './ResourcePreflightPanel';
        export { resourceOverviewState } from './resource_presentation';
        export { createExperienceFixture } from '../../qa/product-experience-fixtures';
    `, resolveDir: fileURLToPath(new URL('.', import.meta.url)), loader: 'tsx' },
    bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false, jsx: 'automatic',
});
const module = { exports: {} };
new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(require, module, module.exports);
const { ProjectOverview, HardwareResourceInspector, ResourcePreflightPanel, resourceOverviewState, createExperienceFixture } = module.exports;
const resources = {};
for (const locale of ['en-US', 'zh-CN']) {
    resources[locale] = {};
    for (const ns of ['health', 'build']) resources[locale][ns] = JSON.parse(await readFile(new URL(`../locales/${locale}/${ns}.json`, import.meta.url), 'utf8'));
}
const i18n = i18next.createInstance();
await i18n.init({ lng: 'en-US', fallbackLng: 'zh-CN', defaultNS: 'health', resources, interpolation: { escapeValue: false } });
const provide = element => React.createElement(I18nextProvider, { i18n }, element);
const render = (Component, props) => new JSDOM(renderToStaticMarkup(provide(React.createElement(Component, props)))).window.document;
const freeze = value => {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    Object.values(value).forEach(freeze); return Object.freeze(value);
};
const viewProps = fixture => ({ view: fixture.view, displayMode: 'simple', onLocateBlock: () => {} });

test('project overview never promotes a selected board or absent results to passed', () => {
    const dom = render(ProjectOverview, { projectName: '用户工程.ck', boardName: 'Vendor board', compileReport: null, resourceReport: null, issues: [], onOpenHealth() {} });
    assert.equal(dom.querySelector('[data-ck-role="project-build-status"]').dataset.status, 'unknown');
    assert.equal(dom.querySelector('[data-ck-role="project-resource-status"]').dataset.status, 'unavailable');
    assert.match(dom.body.textContent, /awaiting resolution/);
    assert.match(dom.body.textContent, /用户工程.ck/);
    const fixture = createExperienceFixture('blink');
    for (const value of ['partial', 'unknown']) {
        const report = { ...fixture.report, available: true, status: 'pass', coverage: { ...fixture.view.coverage, graph: value, analysis: value, declaration: value, project: value } };
        assert.equal(resourceOverviewState(report), value);
    }
});

test('Uno D13 renders digital usage separately from folded SCK capability', () => {
    const fixture = freeze(createExperienceFixture('blink'));
    const before = JSON.stringify(fixture);
    const dom = render(HardwareResourceInspector, viewProps(fixture));
    const pin = dom.querySelector('[data-ck-role="resource-pin"][data-resource-id="gpio.13"]');
    assert.ok(pin);
    assert.match(pin.querySelector('[data-ck-role="pin-current-usage"]').textContent, /Digital output/);
    assert.doesNotMatch(pin.querySelector('[data-ck-role="pin-current-usage"]').textContent, /SPI|SCK/);
    assert.match(pin.querySelector('details').textContent, /SCK/);
    assert.equal(pin.querySelector('details').open, false);
    assert.ok(dom.querySelector('[data-ck-role="unused-resource-pins"]'), 'unused pins remain accessible');
    assert.equal(JSON.stringify(fixture), before);
});

test('one I2C bus groups three devices; one SPI bus groups two and neither warns about sharing', () => {
    const fixture = freeze(createExperienceFixture('shared'));
    const dom = render(HardwareResourceInspector, viewProps(fixture));
    const i2c = dom.querySelectorAll('[data-ck-role="hardware-resource-bus"][data-resource-id="i2c0"]');
    assert.equal(i2c.length, 1);
    assert.match(i2c[0].querySelector('summary').textContent, /3 devices/);
    assert.equal(fixture.report.issues.length, 0, JSON.stringify(fixture.report.issues.map(issue => ({ code: issue.code, resource: issue.resource }))));
    assert.equal(fixture.report.status, 'pass');
    const spi = freeze(createExperienceFixture('spi'));
    const spiDom = render(HardwareResourceInspector, viewProps(spi));
    assert.equal(spiDom.querySelectorAll('[data-ck-role="hardware-resource-bus"]').length, 1);
    assert.match(spiDom.querySelector('[data-ck-role="hardware-resource-bus"] summary').textContent, /2 devices/);
    assert.equal(spi.report.issues.length, 0);
    assert.equal(spi.report.status, 'pass');
});

test('existing classic SPI route gaps are displayed, never silently rewritten as complete', () => {
    const fixture = freeze(createExperienceFixture('spi-route-gap'));
    assert.ok(fixture.analysis.gaps.length > 0);
    const dom = render(ResourcePreflightPanel, { report: fixture.report, displayMode: 'simple', onLocateBlock() {} });
    assert.equal(dom.querySelectorAll('[data-ck-role="resource-preflight-check"][data-preflight-status="warning"]').length, fixture.report.issues.filter(issue => issue.severity === 'warning').length);
    assert.equal(fixture.report.status, 'warning');
});
test('partial and unknown coverage never get a green no-conflict conclusion', () => {
    for (const coverage of ['full', 'partial', 'unknown']) {
        const fixture = createExperienceFixture('third-party');
        Object.assign(fixture.view.coverage, { graph: coverage, analysis: coverage, declaration: coverage, project: coverage });
        const dom = render(HardwareResourceInspector, viewProps(fixture));
        const badge = dom.querySelector('[data-ck-role="resource-inspector-conclusion"]');
        assert.equal(badge.dataset.status, coverage === 'full' ? 'normal' : coverage);
        if (coverage !== 'full') assert.doesNotMatch(badge.className, /emerald/);
        assert.match(dom.querySelector('[data-ck-role="resource-coverage-summary"]').textContent, /Not tested/);
    }
});

test('an unused board reservation is neutral, while an actual reserved-resource conflict stays red', () => {
    const fixture = createExperienceFixture('third-party');
    const pin = fixture.view.pins[0];
    pin.status = 'reserved';
    pin.currentUsage = [];
    pin.references = [];
    pin.referenceCount = 0;
    const findBadge = doc => doc.querySelector(`[data-ck-role="resource-pin"][data-resource-id="${pin.id}"] [data-ck-role="pin-status"]`);
    const neutral = findBadge(render(HardwareResourceInspector, viewProps(fixture)));
    assert.match(neutral.textContent, /System-reserved/);
    assert.doesNotMatch(neutral.className, /red-|amber-/);
    pin.conflicts = [{ code: 'reserved-resource', resource: pin.id, claims: ['sensor'] }];
    const conflict = findBadge(render(HardwareResourceInspector, viewProps(fixture)));
    assert.match(conflict.textContent, /Conflict/);
    assert.match(conflict.className, /red-/);
});

test('USB stays independent from UART; LEDC remains unresolved; third-party takes the same view', () => {
    const usb = createExperienceFixture('usb');
    assert.ok(usb.view.usbSerialJtag.length > 0);
    assert.ok(usb.view.uarts.every(uart => uart.id !== 'usb-serial-jtag'));
    assert.match(render(HardwareResourceInspector, viewProps(usb)).body.textContent, /USB Serial\/JTAG/);
    const ledc = createExperienceFixture('ledc');
    assert.match(render(HardwareResourceInspector, viewProps(ledc)).body.textContent, /Dynamic channel · unresolved/);
    const vendor = createExperienceFixture('third-party');
    assert.match(render(HardwareResourceInspector, viewProps(vendor)).body.textContent, /VendorWire/);
    assert.equal(vendor.view.coverage.evidence.status, 'declared');
});

test('simple view keeps every issue visible and folds only completed checks and evidence', () => {
    const fixture = createExperienceFixture('conflict');
    const checks = Array.from({ length: 7 }, (_, index) => ({ ...fixture.report.checks[0], id: `issue-${index}` }));
    checks.unshift({ ...checks[0], id: 'passing', severity: 'pass', status: 'pass', code: 'shared-bus' });
    const report = freeze({ ...fixture.report, checks });
    const dom = render(ResourcePreflightPanel, { report, displayMode: 'simple', onLocateBlock() {} });
    const issues = [...dom.querySelectorAll('[data-preflight-status="conflict"][data-ck-role="resource-preflight-check"]')];
    assert.equal(issues.length, 7);
    assert.ok(issues.every(node => !node.closest('details')), 'no conflict is hidden inside collapsed content');
    assert.equal(dom.querySelector('[data-ck-role="preflight-completed-checks"]').open, false);
    assert.match(dom.body.textContent, /7 resource conflict/);
});

test('hot switching presentation preserves graph, claims, bindings, evidence and locator identity', async () => {
    const fixture = freeze(createExperienceFixture('conflict'));
    const before = JSON.stringify(fixture);
    const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
    const previous = { window: globalThis.window, document: globalThis.document, act: globalThis.IS_REACT_ACT_ENVIRONMENT };
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    let located;
    const root = createRoot(dom.window.document.getElementById('root'));
    try {
        await act(async () => root.render(provide(React.createElement(HardwareResourceInspector, { ...viewProps(fixture), onLocateBlock: id => { located = id; } }))));
        assert.match(dom.window.document.body.textContent, /Hardware resource conflict/);
        const click = () => dom.window.document.querySelector('[data-ck-role="resource-conflict-locate"][data-block-id="servo-1"]').click();
        await act(async () => click());
        assert.equal(located, 'servo-1');
        await act(async () => i18n.changeLanguage('zh-CN'));
        assert.match(dom.window.document.body.textContent, /硬件资源冲突/);
        assert.doesNotMatch(dom.window.document.body.textContent, /Hardware resource conflict/);
        await act(async () => click());
        assert.equal(located, 'servo-1');
        await act(async () => i18n.changeLanguage('en-US'));
        assert.equal(JSON.stringify(fixture), before);
    } finally {
        await act(async () => root.unmount());
        globalThis.window = previous.window; globalThis.document = previous.document;
        globalThis.IS_REACT_ACT_ENVIRONMENT = previous.act;
        dom.window.close();
    }
});

test('new presentation modules cannot call analyzers, compiler, storage or Blockly mutators', async () => {
    for (const name of ['ProjectOverview.tsx', 'resource_presentation.ts', 'HardwareResourceInspector.tsx', 'ResourcePreflightPanel.tsx']) {
        const source = await readFile(new URL(name, import.meta.url), 'utf8');
        assert.doesNotMatch(source, /analyzeHardwareResources|analyzeProductionResolvedResources|evaluateResourcePreflight|invoke\(|localStorage|setFieldValue|serialization\.workspaces\.load/);
        assert.doesNotMatch(source, /Arduino|Uno|Nano|Mega|ESP32/);
    }
});
