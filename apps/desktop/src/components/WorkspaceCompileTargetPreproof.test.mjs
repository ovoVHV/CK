import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const workspace = await readFile(new URL('./Workspace.tsx', import.meta.url), 'utf8');
const backend = await readFile(new URL('../../src-tauri/src/lib.rs', import.meta.url), 'utf8');
const service = await readFile(new URL('../services/compile_target_preproof.ts', import.meta.url), 'utf8');

test('stable complete FQBN is preproved after a short 50 ms debounce', () => {
    assert.match(workspace, /const targetFqbn = String\(effectiveCompileFqbn \|\| ''\)\.trim\(\)/);
    assert.match(workspace, /preproofCompileTarget\(targetFqbn, activeBoardPackageId\)/);
    assert.match(workspace, /\}, 50\)/);
    assert.match(workspace, /boardOptionsStatus === 'loading'[\s\S]{0,120}boardOptionsStatus === 'unverified'/);
});

test('target changes cancel pending debounce and ignore stale IPC results', () => {
    assert.match(workspace, /window\.clearTimeout\(timer\)/);
    assert.match(workspace, /compileTargetPreproofSeqRef\.current !== requestId[\s\S]{0,160}effectiveCompileFqbnRef\.current !== targetFqbn/);
    assert.match(workspace, /compileTargetPreproofSeqRef\.current \+= 1/);
});

test('preproof remains read-only and never routes into compile upload or warmup', () => {
    const localStart = backend.indexOf('fn resolve_compile_target_preproof_fqbn_local(');
    const start = backend.indexOf('async fn preproof_compile_target(');
    const end = backend.indexOf('\n#[cfg(test)]\nmod compile_target_preproof_tests', start);
    assert.ok(localStart >= 0 && start > localStart && end > start,
        'backend local resolver and preproof command must remain discoverable');
    const command = backend.slice(start, end);
    const fullLocalPath = backend.slice(localStart, end);
    assert.match(command, /managed_package_mutation_gate\(\)\.read\(\)\.await/);
    assert.match(command, /spawn_blocking/);
    assert.match(command, /resolve_toolchain_cache_key_from_root/);
    assert.doesNotMatch(command, /compile_sketch|upload_sketch|warmup_board|enqueue_|ArduinoClient/);
    assert.match(fullLocalPath, /installed_board_option_schema\(sysroot_root, &resolved_base\)/);
    assert.match(fullLocalPath, /local_custom_compile_target_mapping/);
    assert.doesNotMatch(
        fullLocalPath,
        /resolve_board_fqbn\(|get_board_option_schema\(|get_board_details\(|ArduinoClient::new|\.run_command\(|std::process::Command::new/,
        'the whole opportunistic path must stay local instead of gaining a CLI fallback',
    );
});

test('frontend treats preproof as bounded evidence rather than build authorization', () => {
    assert.match(service, /Invalid compile-target preproof response/);
    assert.match(service, /The result is diagnostic evidence, never an authorization/);
    assert.match(workspace, /The foreground compile repeats[\s\S]{0,100}authoritative check/);
});

test('first compile is not discarded while board options are loading', () => {
    assert.match(workspace, /Object\.keys\(boardOptions\)\.length === 0[\s\S]{0,500}直接使用 Core 默认配置开始/);
    assert.match(workspace, /pendingBoardOptionBuildRef\.current = \{/);
    assert.match(workspace, /完成后将自动\$\{action\}（无需再次点击）/);
    assert.match(workspace, /板卡选项校验完成（等待 \$\{waitedSeconds\} 秒）/);
    assert.doesNotMatch(workspace, /正在读取当前板卡的完整编译配置，请稍候/);
});
