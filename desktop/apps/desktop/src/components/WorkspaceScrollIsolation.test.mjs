import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const workspaceSource = await readFile(new URL('./Workspace.tsx', import.meta.url), 'utf8');
const pinPreflightSource = await readFile(new URL('../services/pin_preflight.ts', import.meta.url), 'utf8');

test('compile-log auto scroll is isolated to its own scroll container', () => {
    const effectStart = workspaceSource.indexOf('// Auto-scroll only the compile-log pane.');
    const effectEnd = workspaceSource.indexOf('// Resize Blockly on layout change/resize', effectStart);

    assert.ok(effectStart >= 0 && effectEnd > effectStart, 'compile-log scroll effect should exist');
    const effect = workspaceSource.slice(effectStart, effectEnd);
    assert.match(effect, /const container = compileLogScrollRef\.current/);
    assert.match(effect, /container\.scrollTop = container\.scrollHeight/);
    assert.doesNotMatch(effect, /\.scrollIntoView\s*\(/);

    assert.match(
        workspaceSource,
        /ref=\{compileLogScrollRef\}[\s\S]{0,180}data-ck-role="compile-log-scroll-container"[\s\S]{0,180}overflow-auto overscroll-contain/,
    );
});

test('workspace never uses DOM scrollIntoView for streamed build output', () => {
    assert.doesNotMatch(workspaceSource, /\.scrollIntoView\s*\(/);
    assert.match(
        workspaceSource,
        /listen\('build-log',[\s\S]{0,500}appendCompileLog\(line\)/,
        'the streamed build-log path remains covered by the isolated pane scroll',
    );
});

test('live pin preflight remains a read-only analysis with no viewport operation', () => {
    const analysisStart = pinPreflightSource.indexOf('export const analyzePinPreflight =');
    assert.ok(analysisStart >= 0, 'pin preflight implementation should exist');
    const analysis = pinPreflightSource.slice(analysisStart);

    assert.doesNotMatch(analysis, /scrollIntoView|centerOnBlock|scrollTop\s*=|\.select\s*\(/);
});
