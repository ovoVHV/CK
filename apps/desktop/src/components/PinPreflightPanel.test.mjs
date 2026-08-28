import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('./PinPreflightPanel.tsx', import.meta.url), 'utf8');
const transpiled = ts.transpileModule(source, {
    compilerOptions: {
        jsx: ts.JsxEmit.ReactJSX,
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2020,
    },
    fileName: 'PinPreflightPanel.tsx',
    reportDiagnostics: true,
});

const syntaxErrors = (transpiled.diagnostics || []).filter(
    diagnostic => diagnostic.category === ts.DiagnosticCategory.Error,
);
assert.deepEqual(syntaxErrors, [], 'PinPreflightPanel.tsx should transpile without syntax errors');

test('renders a searchable full-board risk map with deterministic filters', () => {
    assert.match(source, /精确引脚风险图/);
    assert.match(source, /aria-label="搜索当前板卡引脚"/);
    assert.match(source, /搜索 GPIO、D2、SDA、能力、风险或使用积木/);
    assert.match(source, /\['all', '全部'\]/);
    assert.match(source, /\['used', '已占用'\]/);
    assert.match(source, /\['risk', '有风险'\]/);
    assert.match(source, /\['available', '未占用'\]/);
    assert.match(source, /未声明的能力和电气风险按未知处理，不代表已经验证安全/);
    assert.match(source, /report\.catalog/);
});

test('labels evidence level and refuses to invent a physical pin layout', () => {
    assert.match(source, /CK 已验证数据/);
    assert.match(source, /发布者声明/);
    assert.match(source, /基础引脚目录/);
    assert.match(source, /板卡包未声明物理坐标，不猜测排针位置/);
    assert.match(source, /发布者声明，仅警告/);
    assert.match(source, /effectiveRiskSeverity/);
});

test('keeps unused board risks visually neutral and labels them informational', () => {
    assert.match(source, /const isUsed = pin\.usages\.length > 0/);
    assert.match(source, /isUsed && pin\.activeRisks/);
    assert.match(source, /未使用，仅板级提示/);
    assert.match(source, /未使用）/);
});
