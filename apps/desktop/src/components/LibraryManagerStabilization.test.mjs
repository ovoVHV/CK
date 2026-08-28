import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./LibraryManagerModal.tsx', import.meta.url), 'utf8');
const toolboxSetup = await readFile(new URL('./blockly_setup.ts', import.meta.url), 'utf8');

test('local CK and Arduino imports accept multiple files and process a visible queue sequentially', () => {
    assert.ok((source.match(/multiple:\s*true/g) || []).length >= 2);
    assert.match(source, /for \(let index = 0; index < queue\.length; index \+= 1\)/);
    assert.match(source, /updateImportQueueItem\(item\.id, \{ status: 'running'/);
    assert.match(source, />本地导入队列</);
    assert.match(source, />查看完整拒绝原因</);
    assert.match(source, /describeLibraryOperationError\(error\)/);
});

test('online installs expose active stage, elapsed time, queue position, and disabled-button reason', () => {
    assert.match(source, /activeLibraryOperation\.stage/);
    assert.match(source, /已等待 \{operationElapsedSeconds\}s/);
    assert.match(source, /队列 \$\{activeLibraryOperation\.current\}\/\$\{activeLibraryOperation\.total\}/);
    assert.match(source, /title=\{cloudBusy \? libraryBusyReason/);
    assert.match(source, /title=\{arduinoBusy \? libraryBusyReason/);
    assert.doesNotMatch(source, /cloudBusy \? '请等待'/);
});

test('third-party toolbox categories are routed through the compact extension group', () => {
    assert.match(toolboxSetup, /compactExtensionToolboxXml\(extensionXml\)/);
});
