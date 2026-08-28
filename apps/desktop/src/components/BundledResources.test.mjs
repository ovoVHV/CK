import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const tauriRoot = new URL('../../src-tauri/', import.meta.url);
const config = JSON.parse(await readFile(new URL('tauri.conf.json', tauriRoot), 'utf8'));
const resources = config.bundle?.resources ?? {};

test('Windows bundled tools and GPL license use stable installed paths', async () => {
    assert.equal(resources['bin/arduino-cli.exe'], 'bin/arduino-cli.exe');
    assert.equal(resources['../../../tools/ccache.exe'], 'bin/ccache.exe');
    assert.equal(resources['bin/GPL-3.0.txt'], 'licenses/GPL-3.0.txt');
    assert.equal(resources['THIRD_PARTY_NOTICES.md'], 'THIRD_PARTY_NOTICES.md');

    assert.equal(resources['bin/LICENSE.txt'], undefined, 'legacy license source would be renamed by MSI');
    assert.equal(
        existsSync(fileURLToPath(new URL('bin/LICENSE.txt', tauriRoot))),
        false,
        'legacy LICENSE.txt must not coexist with the canonical GPL-3.0.txt source',
    );
    assert.equal(existsSync(fileURLToPath(new URL('bin/GPL-3.0.txt', tauriRoot))), true);

    const notices = await readFile(new URL('THIRD_PARTY_NOTICES.md', tauriRoot), 'utf8');
    assert.match(notices, /Arduino CLI 1\.4\.1/);
    assert.match(notices, /ccache 4\.10\.2/);
    assert.match(notices, /licenses\/GPL-3\.0\.txt/);
});
