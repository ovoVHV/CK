import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const sourcePath = new URL('./last_working_version_presentation.ts', import.meta.url);
const source = await readFile(sourcePath, 'utf8');
const transpiled = ts.transpileModule(source, {
    compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
    },
    fileName: 'last_working_version_presentation.ts',
    reportDiagnostics: true,
});
assert.deepEqual(
    (transpiled.diagnostics || []).filter(item => item.category === ts.DiagnosticCategory.Error),
    [],
);
const service = await import(
    `data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString('base64')}`
);

test('locale label maps can hot-switch without changing diff group identity', () => {
    const group = 'workspace';

    assert.equal(
        service.lastWorkingDiffGroupLabel(group, service.LAST_WORKING_DIFF_GROUP_LABELS_ZH_CN),
        '代码与积木',
    );
    assert.equal(
        service.lastWorkingDiffGroupLabel(
            group,
            service.lastWorkingDiffGroupLabelsForLocale('en-US'),
        ),
        'Code & Blocks',
    );
    assert.equal(service.resolveLastWorkingPresentationLocale('en-GB'), 'en-US');
    assert.equal(service.resolveLastWorkingPresentationLocale('zh-CN'), 'zh-CN');
    assert.equal(group, 'workspace');
});
