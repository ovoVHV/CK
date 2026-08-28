import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const panelSource = await readFile(new URL('./CompileDoctorPanel.tsx', import.meta.url), 'utf8');
const releaseNotesSource = await readFile(new URL('../data/release_notes.ts', import.meta.url), 'utf8');
const reliabilityRoadmapSource = await readFile(
    new URL('../../../../docs/p0-plus-reliability-roadmap.md', import.meta.url),
    'utf8',
);

test('uses 构建体检 consistently for the user-facing product name', () => {
    assert.match(panelSource, /aria-label="构建体检"/);
    assert.match(panelSource, />构建体检<\/span>/);
    assert.match(panelSource, /构建体检正在采集缓存、锁等待和工具链信息/);
    assert.doesNotMatch(panelSource, /编译医生|编译体检/);

    assert.match(releaseNotesSource, /构建体检与工程保护更新/);
    assert.match(releaseNotesSource, /构建体检、资源预算与工程保护/);
    assert.doesNotMatch(releaseNotesSource, /编译医生|编译体检/);

    assert.match(reliabilityRoadmapSource, /成功：构建体检 \+ 资源预算/);
    assert.doesNotMatch(reliabilityRoadmapSource, /成功：CompileDoctor/);
});

test('shows CK Forge toolchain identity evidence only in engineering or folded advanced details', () => {
    assert.match(panelSource, /process-memory[^]*进程内身份复用/);
    assert.match(panelSource, /persistent-metadata[^]*跨进程证据复用/);
    assert.match(panelSource, /strong-content[^]*强内容校验/);
    assert.match(
        panelSource,
        /\{!simple && !compact && \([^]*data-ck-role="toolchain-identity-source"/,
    );
    assert.match(
        panelSource,
        /data-ck-role="compile-doctor-advanced-details"[^]*data-ck-role="toolchain-identity-source-advanced"/,
    );
});

test('shows current Core FLFE qualification and concrete failure reasons', () => {
    assert.match(panelSource, /data-ck-role="forge-core-qualification-status"/);
    assert.match(panelSource, /report\.forgeCoreStatusLabel/);
    assert.match(panelSource, /report\.forgeCoreStatusDetail/);
    assert.match(panelSource, /资格原因：/);
    assert.match(panelSource, /report\.forgeReasonDetails/);
});

test('release notes separate C6 correctness evidence from current FLFE qualification', () => {
    assert.match(releaseNotesSource, /历史正确性\/真板证据/);
    assert.match(releaseNotesSource, /当前 FLFE：Fast 待四阶段验证，不计入 Fast-qualified/);
    assert.match(releaseNotesSource, /板卡功能证据、普通编译通过、Exact 和历史证书均不授予 Fast/);
    assert.match(releaseNotesSource, /不等于当前 FLFE Fast 资格/);
    assert.doesNotMatch(releaseNotesSource, /已验证目标使用产物直达\/热构建/);
});
