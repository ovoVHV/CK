import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readSource = relativePath => readFile(new URL(relativePath, import.meta.url), 'utf8');

const [
    appearanceSource,
    dashboardSource,
    appSource,
    confirmDialogSource,
    dialogContextSource,
    toastSource,
    deviceSelectorSource,
    changelogSource,
    errorBoundarySource,
    workspaceSource,
] = await Promise.all([
    readSource('../components/AppearanceSettingsModal.tsx'),
    readSource('../components/Dashboard.tsx'),
    readSource('../App.tsx'),
    readSource('../components/ui/CKConfirmDialog.tsx'),
    readSource('../contexts/DialogContext.tsx'),
    readSource('../components/ui/Toast.tsx'),
    readSource('../components/DeviceSelectorModal.tsx'),
    readSource('../components/ChangelogModal.tsx'),
    readSource('../components/ErrorBoundary.tsx'),
    readSource('../components/Workspace.tsx'),
]);

test('settings exposes independent UI and block locale selectors', () => {
    assert.match(appearanceSource, /data-ck-role="ui-locale-selector"/);
    assert.match(appearanceSource, /<option value="zh-CN">/);
    assert.match(appearanceSource, /<option value="en-US">/);
    assert.match(appearanceSource, /changeUiLocale\(locale\)/);
    assert.match(appearanceSource, /aria-pressed=\{uiLocale === locale\}/);
    assert.match(appearanceSource, /data-ck-role="block-locale-selector"/);
    assert.match(appearanceSource, /<option value="follow-ui">/);
    assert.match(appearanceSource, /changeBlockLocalePreference\(next\)/);
    assert.match(appearanceSource, /settings\.language\.followInterface/);
    assert.match(appearanceSource, /settings\.language\.blockDescription/);
    assert.match(workspaceSource, /BLOCK_LOCALE_PREFERENCE_CHANGED_EVENT/);
    assert.match(workspaceSource, /getEffectiveBlocklyLocale\(preferences\.blockLocale, uiLocale\)/);
});

test('appearance settings keeps English content scrollable and responsive at narrow widths', () => {
    assert.match(appearanceSource, /max-h-\[calc\(100vh-32px\)\]/);
    assert.match(appearanceSource, /max-w-\[780px\]/);
    assert.match(appearanceSource, /min-h-0 flex-1[^"]*overflow-y-auto/);
    assert.match(appearanceSource, /grid-cols-1 gap-2 sm:grid-cols-2/);
    assert.match(appearanceSource, /grid-cols-1 gap-2 sm:grid-cols-3/);
    assert.match(appearanceSource, /grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3/);
    assert.match(dashboardSource, /min-w-0/);
});

test('the Phase 2B UI surfaces read presentation copy through i18n', () => {
    for (const [name, source] of [
        ['Dashboard', dashboardSource],
        ['App', appSource],
        ['CKConfirmDialog', confirmDialogSource],
        ['DialogContext', dialogContextSource],
        ['Toast', toastSource],
        ['DeviceSelectorModal', deviceSelectorSource],
        ['ChangelogModal', changelogSource],
    ]) {
        assert.match(source, /useTranslation/, `${name} should subscribe to locale changes`);
    }
    assert.match(errorBoundarySource, /i18n\.t\('errorBoundary\./);
});
