import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const cssSource = await readFile(new URL('../index.css', import.meta.url), 'utf8');
const coreSource = await readFile(new URL('./CoreManagerModal.tsx', import.meta.url), 'utf8');
const librarySource = await readFile(new URL('./LibraryManagerModal.tsx', import.meta.url), 'utf8');

test('serial plotter responds to its container width and wraps long quality notices', () => {
    assert.match(cssSource, /\.ck-serial-plotter\s*\{[\s\S]*?container-type:\s*inline-size/);
    assert.match(cssSource, /@container\s*\(max-width:\s*720px\)/);
    assert.match(cssSource, /\.ck-serial-quality-warning\s*>\s*span\s*\{[\s\S]*?-webkit-line-clamp:\s*2/);
});

test('Core and Library dialogs have narrow-window shrink protection', () => {
    assert.match(coreSource, /w-full max-w-\[700px\]/);
    assert.match(coreSource, /max-h-\[calc\(100vh-2rem\)\]/);
    assert.match(coreSource, /flex flex-wrap items-center justify-between gap-3 group/);
    assert.match(librarySource, /flex items-center justify-between gap-3 px-6 py-4/);
    assert.match(librarySource, /className="truncate text-xs text-slate-400/);
});
