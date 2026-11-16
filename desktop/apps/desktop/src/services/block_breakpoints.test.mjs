import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const Blockly = require('blockly');
require('blockly/blocks');

const sourcePath = new URL('./block_breakpoints.ts', import.meta.url);
const source = await readFile(sourcePath, 'utf8');
const transpiled = ts.transpileModule(source, {
    compilerOptions: {
        esModuleInterop: true,
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
    },
    fileName: 'block_breakpoints.ts',
    reportDiagnostics: true,
});
const syntaxErrors = (transpiled.diagnostics || []).filter(
    diagnostic => diagnostic.category === ts.DiagnosticCategory.Error,
);
assert.deepEqual(syntaxErrors, []);

const moduleRecord = { exports: {} };
new Function('require', 'module', 'exports', transpiled.outputText)(
    require,
    moduleRecord,
    moduleRecord.exports,
);
const breakpointService = moduleRecord.exports;

test('breakpoints round-trip with Blockly workspace serialization and stable block IDs', () => {
    const workspace = new Blockly.Workspace();
    const block = workspace.newBlock('controls_repeat_ext');
    const blockId = block.id;
    breakpointService.setBlockBreakpoint(workspace, blockId, true);

    const saved = Blockly.serialization.workspaces.save(workspace);
    assert.deepEqual(saved.ckBreakpoints, { ids: [blockId] });

    Blockly.serialization.workspaces.load(saved, workspace);
    assert.ok(workspace.getBlockById(blockId));
    assert.equal(breakpointService.hasBlockBreakpoint(workspace, blockId), true);
    workspace.dispose();
});

test('serializer omits stale breakpoint IDs but keeps them in memory for undo', () => {
    const workspace = new Blockly.Workspace();
    const block = workspace.newBlock('controls_repeat_ext');
    const blockId = block.id;
    breakpointService.setBlockBreakpoint(workspace, blockId, true);
    block.dispose(false);

    const saved = Blockly.serialization.workspaces.save(workspace);
    assert.equal(saved.ckBreakpoints, undefined);
    assert.equal(breakpointService.hasBlockBreakpoint(workspace, blockId), true);
    workspace.dispose();
});
