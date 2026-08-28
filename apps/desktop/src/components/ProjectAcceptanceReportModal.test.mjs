import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('./ProjectAcceptanceReportModal.tsx', import.meta.url), 'utf8');
const transpiled = ts.transpileModule(source, {
    compilerOptions: {
        jsx: ts.JsxEmit.ReactJSX,
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2020,
    },
    fileName: 'ProjectAcceptanceReportModal.tsx',
    reportDiagnostics: true,
});

test('project acceptance report modal remains valid TSX', () => {
    assert.deepEqual(
        (transpiled.diagnostics || []).filter(item => item.category === ts.DiagnosticCategory.Error),
        [],
    );
});

test('uses a modal instead of another persistent programming sidebar', () => {
    assert.match(source, /fixed inset-0/);
    assert.match(source, /role="dialog"/);
    assert.match(source, /aria-modal="true"/);
    assert.doesNotMatch(source, /EngineeringHealthDock|PanelRight|position:\s*fixed[^\n]*right/);
});

test('shows explicit health items without a numeric score', () => {
    assert.match(source, /工程健康检查/);
    assert.match(source, /板卡护照四级状态/);
    assert.match(source, /check\.stages\.map/);
    assert.match(source, /report\.health\.checks\.map/);
    assert.match(source, /明确检查项，不计算综合分数/);
    assert.doesNotMatch(source, /score|healthScore|总分|评分/);
});

test('exports private structured JSON and printable HTML', () => {
    assert.match(source, /JSON\.stringify\(freshReport, null, 2\)/);
    assert.match(source, /projectAcceptanceReportToHtml\(freshReport\)/);
    assert.match(source, /writeTextFile\(path, content\)/);
    assert.match(source, /结构化 JSON/);
    assert.match(source, /打印 \/ 保存 PDF/);
    assert.match(source, /无脚本 HTML/);
    assert.match(source, /默认不导出源码、工程路径、完整 MAC 或串口内容/);
});

test('renders the compact project.ckpkg workflow inside the existing modal', () => {
    assert.match(source, /project\.ckpkg 工程提交包/);
    assert.match(source, /只读打开提交包/);
    assert.match(source, /value="no_source"/);
    assert.match(source, /value="editable_project"/);
    assert.match(source, /value="generated_source"/);
    assert.match(source, /value="editable_and_generated"/);
    assert.match(source, /sourceDisclosureAcknowledged/);
    assert.match(source, /附加脱敏 ck\.lock/);
    assert.match(source, /附加脱敏构建证据摘要/);
    assert.match(source, /onClick=\{\(\) => void exportSubmission\(\)\}/);
    assert.match(source, /onClick=\{\(\) => void importSubmission\(\)\}/);
    assert.match(source, /完整性已校验不等于发布者身份签名/);
    assert.match(source, /包 SHA-256/);
    assert.match(source, /result\.packageFileName/);
    assert.match(source, /result\.packageSha256/);
    assert.match(source, /刚导出的项目提交包身份/);
    assert.match(source, /实际附加 ck\.lock/);
    assert.match(source, /submissionScopeLabel\[importedSubmission\.sourceScope\]/);
    assert.match(source, /未解压到磁盘/);
    assert.doesNotMatch(source, /position:\s*fixed[^\n]*right|ProjectSubmissionDock/);
});

test('readonly package inspection is independent from local report generation and clears stale package state', () => {
    const independent = source.indexOf('aria-label="独立只读打开项目提交包"');
    const reportGate = source.indexOf('{report && (');
    assert.ok(independent >= 0 && reportGate > independent);
    assert.match(source, /if \(!isOpen\) return;[\s\S]*setImportedSubmission\(null\);[\s\S]*void load\(\)/);
    const importStart = source.indexOf('const importSubmission = async');
    const importEnd = source.indexOf('return (', importStart);
    assert.match(source.slice(importStart, importEnd), /setImportedSubmission\(null\);[\s\S]*openFile/);
});

test('does not put submission actions in the modal header', () => {
    const header = source.slice(source.indexOf('<header'), source.indexOf('</header>'));
    assert.doesNotMatch(header, /提交包|FolderInput|PackageCheck/);
});

test('does not pretend checkpoint count is modification count', () => {
    assert.match(source, /工程检查点：\{report\.history\.checkpointCount\}/);
    assert.match(source, /修改次数：未启用审计，保持未知/);
});
