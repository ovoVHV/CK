import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./RecoveryDraftModal.tsx', import.meta.url), 'utf8');
const previewSource = readFileSync(new URL('./RecoveryBlocksPreview.tsx', import.meta.url), 'utf8');
const previewStyles = readFileSync(new URL('./RecoveryBlocksPreview.css', import.meta.url), 'utf8');

test('recovery UI distinguishes drafts from formal project versions', () => {
    assert.match(source, /t\('draft\.title'\)/);
    assert.match(source, /t\('draft\.description'\)/);
    assert.match(source, /t\('draft\.keepForLater'\)/);
    assert.match(source, /t\('draft\.safetyNote'\)/);
});

test('recovery UI exposes all safe resolution paths', () => {
    assert.match(source, /t\('draft\.discard'\)/);
    assert.match(source, /t\('draft\.restoreAs'\)/);
    assert.match(source, /t\('draft\.overwrite'\)/);
    assert.match(source, /t\('draft\.keepForLater'\)/);
    assert.match(source, /t\('draft\.safetyNote'\)/);
});

test('recovery UI explains the candidate before asking to overwrite anything', () => {
    assert.match(source, /t\('draft\.project'\)/);
    assert.match(source, /t\('draft\.createdAt'\)/);
    assert.match(source, /t\('draft\.summary'\)/);
    assert.match(source, /createRecoveryDraftChangeSummary\(currentState, draft\)/);
    assert.match(source, /createRecoveryBlockComparison\(currentState\.workspaceJson, draft\.workspaceJson\)/);
    assert.match(source, /t\('draft\.blockCompare'\)/);
    assert.match(source, /t\('draft\.previewOnly'\)/);
    assert.match(source, /RecoveryBlocksComparison/);
    assert.match(source, /RecoveryBlocksPreview/);
    assert.match(source, /t\('draft\.restoreAs'\)/);
});

test('recovery comparison defaults to visual blocks and keeps source out of the main view', () => {
    assert.match(source, /useState<DetailMode>\('compare'\)/);
    assert.match(previewSource, /t\('compare\.currentTitle'\)/);
    assert.match(previewSource, /t\('compare\.currentCaption'\)/);
    assert.match(previewStyles, /ck-recovery-block-added/);
    assert.match(previewStyles, /ck-recovery-block-removed/);
    assert.match(previewStyles, /ck-recovery-block-changed/);
    assert.match(source, /t\('draft\.compareAria'\)/);
    assert.match(source, /t\('draft\.technicalInfo'\)/);
    assert.doesNotMatch(source, /生成源码逐行差异/);
    assert.doesNotMatch(source, /<pre/);
});

test('large recovery projects can pan, zoom, navigate changes and use a fullscreen comparison', () => {
    assert.match(previewSource, /scrollbars: true/);
    assert.match(previewSource, /drag: true/);
    assert.match(previewSource, /wheel: true/);
    assert.match(previewSource, /minScale: 0\.08/);
    assert.match(previewSource, /workspace\.centerOnBlock\(blockId, true\)/);
    assert.match(previewSource, /t\('compare\.independentHint'\)/);
    assert.match(previewSource, /t\('compare\.changed'/);
    assert.match(previewSource, /t\('compare\.dragHint'\)/);
    assert.match(previewSource, /t\('compare\.fullscreen'\)/);
    assert.match(previewSource, /fixed inset-2 z-\[10050\]/);
    assert.match(previewSource, /h-\[clamp\(26rem,55vh,44rem\)\]/);
    assert.match(previewSource, /new ResizeObserver\(resize\)/);
    assert.doesNotMatch(previewSource, /new ResizeObserver\(fit\)/);
});

test('recovery UI promises to stop when a third-party block is unavailable', () => {
    assert.match(source, /t\('draft\.safetyNote'\)/);
    assert.match(previewSource, /t\('compare\.unknownBlocks'/);
    assert.match(previewSource, /Object\.prototype\.hasOwnProperty\.call\(Blockly\.Blocks, type\)/);
});
