import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const managerSource = await readFile(new URL('./board_manager.ts', import.meta.url), 'utf8');
const selectorSource = await readFile(new URL('../components/BoardSelector.tsx', import.meta.url), 'utf8');
const passportSource = await readFile(new URL('./board_passport.ts', import.meta.url), 'utf8');

for (const [name, source] of [['board_manager.ts', managerSource], ['BoardSelector.tsx', selectorSource]]) {
    const transpiled = ts.transpileModule(source, {
        compilerOptions: {
            module: ts.ModuleKind.ESNext,
            target: ts.ScriptTarget.ES2020,
            jsx: ts.JsxEmit.ReactJSX,
        },
        fileName: name,
        reportDiagnostics: true,
    });
    const errors = (transpiled.diagnostics || []).filter(
        diagnostic => diagnostic.category === ts.DiagnosticCategory.Error,
    );
    assert.deepEqual(errors, [], `${name} should transpile without syntax errors`);
}

test('custom board normalization preserves manifest identity instead of inventing values', () => {
    const normalizeStart = managerSource.indexOf('export const normalizeUserBoard');
    const normalizeEnd = managerSource.indexOf('export class BoardManager');
    const normalizeSource = managerSource.slice(normalizeStart, normalizeEnd);
    assert.match(normalizeSource, /version: textValue\(b\.version, manifest\.version\)/);
    assert.match(normalizeSource, /vendor: vendor \|\| undefined/);
    assert.match(normalizeSource, /fqbn: fqbnBase/);
    assert.match(normalizeSource, /fqbn_base: fqbnBase/);
    assert.match(normalizeSource, /pins: normalizePins\(b\.pins \?\? manifest\.pins\)/);
    assert.doesNotMatch(normalizeSource, /fqbn:\s*b\.id/);
    assert.doesNotMatch(normalizeSource, /version:\s*["']1\.0\.0["']/);
    assert.doesNotMatch(normalizeSource, /pins:\s*\[\]/);
});

test('board selector names the static gate honestly and protects project creation', () => {
    assert.match(selectorSource, /boardSelector\.toast\.qualityPassed/);
    assert.doesNotMatch(selectorSource, /门禁通过|质量门禁通过/);
    assert.match(selectorSource, /resolveBoardPassport\(selectedBoard, installedCoreVersions/);
    assert.match(selectorSource, /if \(!passport\.canCreateProject\)/);
    assert.match(selectorSource, /boardSelector\.dialog\.passportBlocked/);
    assert.match(selectorSource, /canCreateProject=\{!!selectedPassport\?\.canCreateProject\}/);
    assert.match(selectorSource, /boardSelector\.import\.compatibility\.installFailedSuffix/);
    assert.match(selectorSource, /compatibilityText \? "info" : "success"/);
});

test('passport UI exposes all levels and real profile qualification', () => {
    assert.match(selectorSource, /boardSelector\.passport\.stage\.\$\{item\.id\}\.\$\{item\.status\}/);
    assert.match(selectorSource, /boardSelector\.passport\.details/);
    assert.match(selectorSource, /invoke\('qualify_board_profiles', \{ boardId \}\)/);
    assert.match(selectorSource, /invoke\('check_core_compatibility'/);
    assert.match(selectorSource, /validation_profiles/);
    assert.match(selectorSource, /boardSelector\.passport\.qualification\.title/);
    assert.match(selectorSource, /compile_passed/);
    assert.match(selectorSource, /blocked_core/);
    assert.match(selectorSource, /coreEnvironmentBlocksUse\(coreStatus\) \? 'failed' : 'warning'/);
    assert.match(selectorSource, /tested_non_recommended/);
    assert.match(selectorSource, /profile\.status === 'warning' \? 'text-amber-600/);
    assert.match(selectorSource, /boardSelector\.passport\.qualification\.verify/);
    assert.match(selectorSource, /passport\.lockSummary/);
    assert.match(selectorSource, /t\('boardSelector\.passport\.qualification\.installRecommended'\)/);
});

test('non-blocking core compatibility states stay usable and are not rendered as import errors', () => {
    assert.doesNotMatch(
        selectorSource,
        /compatibilityStatus === 'known_incompatible' \|\| compatibilityStatus === 'incompatible'/,
    );
    assert.match(selectorSource, /\['warning', 'incompatible', 'compatible', 'compatible_untested', 'tested_non_recommended'/);
    assert.match(selectorSource, /result\?\.core \?\? result\?\.passport\?\.core \?\? board\?\.core_status/);
    assert.match(passportSource, /coreStatusTokensFrom\(value\)\.some\(token => CORE_ENVIRONMENT_BLOCK_TOKENS\.has\(token\)\)/);
    assert.match(passportSource, /legacyCoreWarningCanOverrideUsableFalse/);
    assert.match(passportSource, /environmentReport\?\.usable === false \|\| staleBlockedCorePassport/);
});

test('board passport cards expose concrete evidence and four-level status labels', () => {
    assert.match(selectorSource, /boardSelector\.passport\.stage\.\$\{item\.id\}\.\$\{item\.status\}/);
    for (const fieldKey of ['completeFqbn', 'currentCore', 'recommendedCore', 'verifiedCore', 'lastVerified', 'deviceModel', 'expired']) {
        assert.match(selectorSource, new RegExp(`boardSelector\\.passport\\.${fieldKey}`));
    }
    assert.match(selectorSource, /const facts = resolveBoardPassportFacts\(board, passport\)/);
    assert.match(selectorSource, /facts\.completeFqbns\.map/);
    assert.match(selectorSource, /boardSelector\.passport\.noDeviceEvidence/);
    assert.doesNotMatch(selectorSource, /variantId,\s*board\.name/);
    assert.match(selectorSource, /passportStageDisplayLabel\(item, t\)/);
});

test('board cards expose FLFE Core qualification separately from board-package recommendations', () => {
    assert.match(selectorSource, /resolveForgeCoreSupport/);
    assert.match(selectorSource, /data-ck-role="board-flfe-core-status"/);
    assert.match(selectorSource, /boardSelector\.passport\.forge\.certified/);
    assert.match(selectorSource, /boardSelector\.passport\.flfe/);
    assert.match(selectorSource, /const forgeDetail = forgeCoreSupportDetail/);
});

test('passport filters keep warnings usable and clear a selection hidden by filters', () => {
    for (const state of ['onlyDeviceVerified', 'onlyEnvironmentUsable', 'onlyRecommendedCore', 'showExpiredCertifications']) {
        assert.match(selectorSource, new RegExp(`const \\[${state}, set`));
    }
    assert.match(selectorSource, /if \(onlyDeviceVerified && !facts\.deviceVerified\) return false/);
    assert.match(selectorSource, /if \(onlyEnvironmentUsable && !facts\.environmentUsable\) return false/);
    assert.match(selectorSource, /if \(onlyRecommendedCore && !facts\.usesRecommendedCore\) return false/);
    assert.match(selectorSource, /if \(!showExpiredCertifications && facts\.isExpired\) return false/);
    assert.match(selectorSource, /environment\?\.status === 'passed' \|\| environment\?\.status === 'warning'/);
    assert.match(selectorSource, /environment\.status !== 'failed'/);
    assert.match(selectorSource, /!filteredBoards\.some\(board => boardPackageKey\(board\) === selected\)/);
    assert.match(selectorSource, /boardSelector\.filters\.environmentUsable/);
    assert.match(selectorSource, /boardSelector\.filters\.reset/);
});

test('import compatibility scans all status fields and warns for non-blocking version drift', () => {
    assert.match(selectorSource, /compatibility\?\.compatibility,\s*compatibility\?\.code,\s*compatibility\?\.status,\s*compatibility\?\.state,\s*compatibility\?\.result/s);
    assert.match(selectorSource, /const belowMinimum = compatibilityTokens\.includes\('below_minimum'\)/);
    assert.match(selectorSource, /const knownIncompatible = compatibilityTokens\.includes\('known_incompatible'\)/);
    assert.match(selectorSource, /!coreEnvironmentBlocksUse\(compatibility\)/);
    assert.match(selectorSource, /boardSelector\.import\.compatibility\.revalidateSuffix/);
    assert.match(selectorSource, /knownIncompatible\) \{/);
});
