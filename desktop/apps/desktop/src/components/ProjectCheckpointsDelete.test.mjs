import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const modalSource = await readFile(new URL('./ProjectCheckpointsModal.tsx', import.meta.url), 'utf8');

const sliceBetween = (startMarker, endMarker) => {
    const start = modalSource.indexOf(startMarker);
    const end = modalSource.indexOf(endMarker, start);
    assert.ok(start >= 0 && end > start, `missing source region: ${startMarker}`);
    return modalSource.slice(start, end);
};

test('checkpoint delete uses the existing native service behind an explicit localized danger confirmation', () => {
    assert.match(modalSource, /deleteProjectCheckpoint/);
    const handler = sliceBetween('const remove = async', 'const nativeAvailable');
    assert.match(handler, /if \(hasActiveOperation \|\| !isNativeCheckpointStorageAvailable\(\)\) return/);
    assert.match(handler, /title: t\('checkpoint\.confirm\.deleteTitle'\)/);
    assert.match(handler, /message: t\('checkpoint\.confirm\.deleteMessage'/);
    assert.match(handler, /tone: 'danger'/);
    assert.match(handler, /confirmLabel: t\('checkpoint\.confirm\.deleteAction'\)/);
    assert.match(handler, /if \(!confirmed\) return/);
    assert.match(handler, /await deleteProjectCheckpoint\(projectPath, metadata\.id\)/);
    assert.match(handler, /await refresh\(\)/);
});

test('delete reports progress and failures without closing or replacing the workspace', () => {
    const handler = sliceBetween('const remove = async', 'const nativeAvailable');
    assert.match(handler, /setDeletingId\(metadata\.id\)/);
    assert.match(handler, /setError\(t\('checkpoint\.errors\.delete', \{ cause: String\(cause\) \}\)\)/);
    assert.match(handler, /finally \{[\s\S]*?setDeletingId\(null\)/);
    assert.doesNotMatch(handler, /onRestore\(|onClose\(/);

    const button = sliceBetween('data-ck-role="delete-project-checkpoint"', '</button>');
    assert.match(button, /disabled=\{hasActiveOperation\}/);
    assert.match(button, /aria-label=\{t\('checkpoint\.deleteAria'/);
    assert.match(button, /deleting \? t\('checkpoint\.deleting'\) : t\('checkpoint\.delete'\)/);
    assert.match(modalSource, /role="alert" aria-live="assertive"/);
});

test('create, refresh, restore and delete share one operation lock', () => {
    assert.match(
        modalSource,
        /const hasActiveOperation = loading \|\| creating \|\| Boolean\(restoringId\) \|\| Boolean\(deletingId\)/,
    );
    assert.match(sliceBetween('const restore = async', 'const createManualCheckpoint'), /if \(hasActiveOperation\) return/);
    assert.match(sliceBetween('data-ck-role="create-manual-checkpoint"', '</button>'), /disabled=\{hasActiveOperation \|\| !nativeAvailable\}/);
    assert.match(sliceBetween('onClick={() => void refresh()}', '</button>'), /disabled=\{hasActiveOperation \|\| !nativeAvailable\}/);
    assert.match(sliceBetween('onClick={() => void restore(checkpoint)}', '</button>'), /disabled=\{hasActiveOperation\}/);
    assert.match(sliceBetween('data-ck-role="delete-project-checkpoint"', '</button>'), /disabled=\{hasActiveOperation\}/);
});

test('checkpoint card actions stack cleanly at narrow widths and remain text-labelled', () => {
    assert.match(modalSource, /flex flex-col items-stretch[^"]*min-\[520px\]:flex-row/);
    assert.match(modalSource, /grid shrink-0 grid-cols-2 gap-2 min-\[520px\]:flex/);
    const button = sliceBetween('data-ck-role="delete-project-checkpoint"', '</button>');
    assert.match(button, /w-full/);
    assert.match(button, /min-\[520px\]:w-auto/);
    assert.match(button, /<Trash2 size=\{14\}/);
});
