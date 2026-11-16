import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./EngineeringHealthDock.tsx', import.meta.url), 'utf8');

test('is a non-modal dock without any page-blocking backdrop', () => {
    assert.match(source, /data-ck-role="engineering-health-dock"/);
    assert.match(source, /<aside/);
    assert.doesNotMatch(source, /fixed inset-0|aria-modal|role="dialog"|backdrop-blur/);
    assert.match(source, /shrink-0/);
    assert.match(source, /max\(\$\{ENGINEERING_HEALTH_DOCK_MIN_WIDTH\}px, min\(\$\{clampDockWidth\(width\)\}px, 44vw\)\)/);
});

test('provides a bounded pointer resizer and an explicit collapse action', () => {
    assert.match(source, /ENGINEERING_HEALTH_DOCK_MIN_WIDTH = 280/);
    assert.match(source, /ENGINEERING_HEALTH_DOCK_MAX_WIDTH = 640/);
    assert.match(source, /role="separator"/);
    assert.match(source, /aria-orientation="vertical"/);
    assert.match(source, /onPointerDown=\{beginResize\}/);
    assert.match(source, /event\.stopPropagation\(\)/);
    assert.match(source, /event\.preventDefault\(\)/);
    assert.match(source, /setPointerCapture\(event\.pointerId\)/);
    assert.match(source, /onPointerMove=\{continueResize\}/);
    assert.match(source, /onPointerUp=\{finishResize\}/);
    assert.match(source, /releasePointerCapture\(event\.pointerId\)/);
    assert.match(source, /onClick=\{onClose\}/);
    assert.match(source, /aria-label=\{t\('dock\.closeTitle'\)\}/);
    assert.match(source, /t\('dock\.collapse'\)/);
});

test('keeps structured reports inside the dock and compacts only at narrow widths', () => {
    assert.match(source, /<EngineeringHealthView/);
    assert.match(source, /compact=\{width < 360\}/);
    assert.match(source, /compileDoctorReport=\{compileDoctorReport\}/);
    assert.match(source, /deviceHealthReport=\{deviceHealthReport\}/);
    assert.match(source, /compileResourceReport=\{compileResourceReport\}/);
    assert.match(source, /pinPreflightReport=\{pinPreflightReport\}/);
});

test('expanded health dock uses a neutral product surface without violet emphasis', () => {
    assert.match(source, /<HeartPulse/);
    assert.match(source, /\{t\('title'\)\}<\/h2>/);
    assert.doesNotMatch(
        source,
        /(?:border|bg|text|ring)-violet-|rgba\(76,29,149/,
        'resizer, header icon and collapse focus state should not turn the whole dock into a violet feature panel',
    );
});
