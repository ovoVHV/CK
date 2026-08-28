import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const helperSource = await readFile(new URL('./package_quality_ui.ts', import.meta.url), 'utf8');
const panelSource = await readFile(new URL('../components/PackageQualityReportPanel.tsx', import.meta.url), 'utf8');
const passportSource = await readFile(new URL('../components/BlockPackagePassport.tsx', import.meta.url), 'utf8');
const librarySource = await readFile(new URL('../components/LibraryManagerModal.tsx', import.meta.url), 'utf8');
const boardSource = await readFile(new URL('../components/BoardSelector.tsx', import.meta.url), 'utf8');

const transpiled = ts.transpileModule(helperSource, {
    compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2020,
    },
    fileName: 'package_quality_ui.ts',
    reportDiagnostics: true,
});
const errors = (transpiled.diagnostics || []).filter(
    diagnostic => diagnostic.category === ts.DiagnosticCategory.Error,
);
assert.deepEqual(errors, []);
const qualityUi = await import(`data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString('base64')}`);

test('failed reports are explicitly blocked and never treated as trusted', () => {
    const failed = qualityUi.qualityStatusSummary({ status: 'failed' });
    assert.equal(failed.label, '已阻止');
    assert.equal(failed.tone, 'danger');
    assert.equal(failed.trusted, false);

    const warnings = qualityUi.qualityStatusSummary({ status: 'passed_with_warnings' });
    assert.equal(warnings.label, '通过但有警告');
    assert.equal(warnings.tone, 'warning');
});

test('quality messages redact local Windows and Unix paths before display', () => {
    assert.equal(
        qualityUi.redactQualityMessage('Invalid file C:\\Users\\Alice\\AppData\\Local\\Temp\\pkg\\board.json'),
        'Invalid file [本机路径]',
    );
    assert.equal(
        qualityUi.redactQualityMessage('Cannot read "/Users/alice/project/library.json"'),
        'Cannot read "[本机路径]"',
    );
    assert.equal(qualityUi.redactQualityMessage('Missing required manifest'), 'Missing required manifest');
});

test('quality report UI exposes auditable evidence and honest trust wording', () => {
    assert.match(panelSource, /data-ck-role="package-quality-report"/);
    for (const text of ['内容 SHA-256', '元数据', '查看', '项检查', '本机自动静态检查结果', '不代表 CK 官方背书', '不等同于真板验证或发布者签名']) {
        assert.match(panelSource, new RegExp(text));
    }
    assert.match(panelSource, /redactQualityMessage\(check\.message\)/);
    assert.match(panelSource, /summary\.tone === 'danger'/);
    for (const field of ['certification_level', 'generated_at', 'contract_sha256']) {
        assert.match(panelSource, new RegExp(`report\\?\\.${field}`));
    }
});

test('installed block libraries and third-party boards expose quality details', () => {
    assert.match(librarySource, /<PackageQualityStatusBadge report=\{lib\.quality_report\}/);
    assert.match(librarySource, /<PackageQualityReportPanel/);
    assert.match(librarySource, /质量报告/);
    assert.match(librarySource, /导入前自动质量检查/);
    assert.match(librarySource, /<BlockPackagePassportBadge library=\{lib\}/);
    assert.match(librarySource, /<BlockPackagePassportPanel library=\{lib\}/);
    assert.match(librarySource, /质量与证据/);
    assert.doesNotMatch(librarySource, /门禁通过/);

    assert.match(passportSource, /data-ck-role="block-package-passport"/);
    assert.match(passportSource, /不计算综合分/);

    assert.match(boardSource, /\(board\.is_custom \|\| board\.quality_report\)/);
    assert.match(boardSource, /<PackageQualityReportPanel/);
    assert.match(boardSource, /用户导入的第三方板卡包/);
    assert.match(boardSource, /本地 ZIP 与仓库包使用同一套/);
});
