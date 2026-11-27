import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('./cloud_registry_source.ts', import.meta.url), 'utf8');
const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: 'cloud_registry_source.ts',
    reportDiagnostics: true,
});
assert.deepEqual(
    (transpiled.diagnostics || []).filter((item) => item.category === ts.DiagnosticCategory.Error),
    [],
);
const {
    CLOUD_REGISTRY_STORAGE_KEYS,
    DEFAULT_GITEE_REGISTRY_URL,
    DEFAULT_GITHUB_REGISTRY_URL,
    detectCloudProviderFromUrl,
    loadInitialCloudRegistryState,
    persistCloudRegistryState,
    reconcileCloudRegistrySubmit,
    resolveCloudProviderSwitch,
} = await import(`data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString('base64')}`);

function memoryStorage(initial = {}) {
    const map = new Map(Object.entries(initial));
    return {
        getItem(key) {
            return map.has(key) ? map.get(key) : null;
        },
        setItem(key, value) {
            map.set(key, String(value));
        },
        snapshot() {
            return Object.fromEntries(map.entries());
        },
    };
}

test('detectCloudProviderFromUrl distinguishes GitHub and Gitee URLs', () => {
    assert.equal(detectCloudProviderFromUrl('https://gitee.com/manong1234/makerlib.git'), 'gitee');
    assert.equal(detectCloudProviderFromUrl('https://github.com/ovoVHV/CK-Libraries.git'), 'github');
    assert.equal(detectCloudProviderFromUrl('git@github.com:ovoVHV/CK-Libraries.git'), 'github');
    assert.equal(detectCloudProviderFromUrl('https://example.com/custom/repo.git'), null);
});

test('switching from GitHub to Gitee replaces the GitHub URL with Gitee URL and remembers GitHub URL', () => {
    const switched = resolveCloudProviderSwitch(
        'gitee',
        'github',
        'https://github.com/ovoVHV/CK-Libraries.git',
        {},
    );
    assert.equal(switched.provider, 'gitee');
    assert.equal(switched.url, DEFAULT_GITEE_REGISTRY_URL);
    assert.equal(switched.savedUrls.github, 'https://github.com/ovoVHV/CK-Libraries.git');

    const backToGithub = resolveCloudProviderSwitch(
        'github',
        switched.provider,
        switched.url,
        switched.savedUrls,
    );
    assert.equal(backToGithub.provider, 'github');
    assert.equal(backToGithub.url, 'https://github.com/ovoVHV/CK-Libraries.git');
    assert.equal(backToGithub.savedUrls.gitee, DEFAULT_GITEE_REGISTRY_URL);
});

test('switching from Gitee to GitHub defaults to CK-Libraries when no custom GitHub URL was saved', () => {
    const switched = resolveCloudProviderSwitch(
        'github',
        'gitee',
        DEFAULT_GITEE_REGISTRY_URL,
        {},
    );
    assert.equal(switched.provider, 'github');
    assert.equal(switched.url, DEFAULT_GITHUB_REGISTRY_URL);
    assert.equal(switched.savedUrls.gitee, DEFAULT_GITEE_REGISTRY_URL);
});

test('loadInitialCloudRegistryState heals legacy mismatched provider=gitee with GitHub URL', () => {
    const storage = memoryStorage({
        [CLOUD_REGISTRY_STORAGE_KEYS.provider]: 'gitee',
        [CLOUD_REGISTRY_STORAGE_KEYS.url]: 'https://github.com/ovoVHV/CK-Libraries.git',
    });
    const loaded = loadInitialCloudRegistryState(storage);
    assert.equal(loaded.provider, 'gitee');
    assert.equal(loaded.url, DEFAULT_GITEE_REGISTRY_URL);
    assert.equal(loaded.savedUrls.github, 'https://github.com/ovoVHV/CK-Libraries.git');
});

test('reconcileCloudRegistrySubmit aligns provider when user manually enters a URL from the other host', () => {
    assert.deepEqual(
        reconcileCloudRegistrySubmit('gitee', 'https://github.com/ovoVHV/CK-Libraries.git'),
        { provider: 'github', url: 'https://github.com/ovoVHV/CK-Libraries.git' },
    );
    assert.deepEqual(
        reconcileCloudRegistrySubmit('github', 'https://gitee.com/manong1234/makerlib.git'),
        { provider: 'gitee', url: 'https://gitee.com/manong1234/makerlib.git' },
    );
    assert.deepEqual(
        reconcileCloudRegistrySubmit('auto', 'https://github.com/ovoVHV/CK-Libraries.git'),
        { provider: 'auto', url: 'https://github.com/ovoVHV/CK-Libraries.git' },
    );
});

test('persistCloudRegistryState keeps separate per-provider URLs intact across switches', () => {
    const storage = memoryStorage();
    const s1 = resolveCloudProviderSwitch('github', 'gitee', 'https://gitee.com/custom/teamlib.git', {});
    persistCloudRegistryState(storage, s1.provider, s1.url, s1.savedUrls);
    const snap = storage.snapshot();
    assert.equal(snap[CLOUD_REGISTRY_STORAGE_KEYS.provider], 'github');
    assert.equal(snap[CLOUD_REGISTRY_STORAGE_KEYS.url], DEFAULT_GITHUB_REGISTRY_URL);
    assert.equal(snap[CLOUD_REGISTRY_STORAGE_KEYS.giteeUrl], 'https://gitee.com/custom/teamlib.git');
    assert.equal(snap[CLOUD_REGISTRY_STORAGE_KEYS.githubUrl], DEFAULT_GITHUB_REGISTRY_URL);
});
