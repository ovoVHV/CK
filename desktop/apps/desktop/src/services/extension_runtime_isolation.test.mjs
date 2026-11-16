import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const loader = readFileSync(new URL('./extension_loader.ts', import.meta.url), 'utf8');
const backendExtensions = readFileSync(
    new URL('../../src-tauri/src/extensions.rs', import.meta.url),
    'utf8',
);
const registry = readFileSync(
    new URL('../../src-tauri/src/lib_custom_registry.rs', import.meta.url),
    'utf8',
);
const runtimeTrust = readFileSync(
    new URL('../../src-tauri/src/runtime_trust.rs', import.meta.url),
    'utf8',
);

test('extension loader has no dynamic JavaScript compilation primitive', () => {
    assert.doesNotMatch(loader, /\bnew\s+Function\b/);
    assert.doesNotMatch(loader, /\beval\s*\(/);
    assert.doesNotMatch(loader, /compileLegacyDynamicFunction|executeLegacyBlocksScript/);
    assert.doesNotMatch(loader, /resolveLegacyBlocksScriptPath|resolveLegacyGeneratorScriptPath/);
    assert.match(loader, /parseDeclarativeBlockDocument\(blockJsonStrRaw\)/);
    assert.match(loader, /parseDeclarativeGeneratorDocument\(declarativeSource\)/);
});

test('legacy discovery and exact-hash approval cannot expose scripts to the WebView', () => {
    assert.doesNotMatch(backendExtensions, /extension_runtime_is_approved/);
    assert.match(backendExtensions, /Skipped legacy extension runtime \(no isolated JavaScript worker\)/);
    assert.match(registry, /state: "legacy-disabled"\.to_string\(\)/);
    assert.match(registry, /Exact-hash approval is an identity record, not a sandbox/);
    assert.match(registry, /block_entrypoints = ResolvedBlockEntrypoints::default\(\)/);
    assert.match(runtimeTrust, /state: "legacy-disabled"\.to_string\(\)/);
    assert.match(runtimeTrust, /does not accept runtime approval for executable block JavaScript/);
    assert.doesNotMatch(runtimeTrust, /self\.state == "approved" \|\|/);
});

test('declarative resource checks run before Blockly sees block or toolbox data', () => {
    assert.match(loader, /parseDeclarativeToolboxDocument\(toolboxJsonStr\)/);
    assert.match(loader, /validateDeclarativeToolboxXml\(await readTextFileCached\(xmlPath\)\)/);
    assert.match(registry, /validate_declarative_json_resources\(&value\)/);
    assert.match(registry, /field_image, which is disabled/);
});
