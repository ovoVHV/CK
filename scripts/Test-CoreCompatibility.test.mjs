import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const scriptUrl = new URL('./Test-CoreCompatibility.ps1', import.meta.url);
const source = await readFile(scriptUrl, 'utf8');

function quotePowerShell(value) {
    return value.replaceAll("'", "''");
}

test('core compatibility evidence is atomically written without BOM and parses in Node', async (t) => {
    const shell = process.platform === 'win32' ? 'powershell' : 'pwsh';
    const probe = spawnSync(shell, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], {
        encoding: 'utf8',
    });
    if (probe.error?.code === 'ENOENT') {
        t.skip(`${shell} is unavailable`);
        return;
    }
    assert.equal(probe.status, 0, probe.stderr);

    const writerStart = source.indexOf('function Write-Utf8NoBomAtomic');
    const writerEnd = source.indexOf('\nif (-not (Test-Path -LiteralPath $cli))', writerStart);
    assert.ok(writerStart >= 0 && writerEnd > writerStart, 'UTF-8 atomic writer must be extractable');
    const writerSource = source.slice(writerStart, writerEnd);
    assert.match(writerSource, /UTF8Encoding\]::new\(\$false\)/);
    assert.match(writerSource, /finally\s*\{/);
    assert.match(writerSource, /Remove-Item -LiteralPath \$temporary -Force/);
    assert.match(writerSource, /Remove-Item -LiteralPath \$backup -Force/);
    assert.match(source, /Write-Utf8NoBomAtomic -Path \$jsonFile -Content \$serializedDocument/);
    assert.doesNotMatch(source, /\$serializedDocument\s*\|\s*Set-Content[^\n]*-Encoding\s+UTF8/i);

    const fixtureRoot = await mkdtemp(join(tmpdir(), 'ck-core-compatibility-encoding-'));
    t.after(async () => rm(fixtureRoot, { recursive: true, force: true }));
    const reportRoot = join(fixtureRoot, 'reports');
    const createdPath = join(reportRoot, 'created.json');
    const replacedPath = join(reportRoot, 'replaced.json');
    await mkdir(reportRoot, { recursive: true });
    await writeFile(replacedPath, '{"stale":true}\n', 'utf8');

    const fixtureScript = join(fixtureRoot, 'fixture.ps1');
    await writeFile(fixtureScript, `
$ErrorActionPreference = 'Stop'
${writerSource}
$created = ([ordered]@{ schema = 'ck-core-compatibility-results'; version = 1; replaced = $false } | ConvertTo-Json -Compress) + "\`n"
$replaced = ([ordered]@{ schema = 'ck-core-compatibility-results'; version = 1; replaced = $true } | ConvertTo-Json -Compress) + "\`n"
Write-Utf8NoBomAtomic -Path '${quotePowerShell(createdPath)}' -Content $created
Write-Utf8NoBomAtomic -Path '${quotePowerShell(replacedPath)}' -Content $replaced
`, 'utf8');

    const run = spawnSync(shell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', fixtureScript], {
        encoding: 'utf8',
    });
    assert.equal(run.status, 0, `${run.stderr}\n${run.stdout}`);

    for (const [reportPath, expectedReplaced] of [
        [createdPath, false],
        [replacedPath, true],
    ]) {
        const bytes = await readFile(reportPath);
        assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
        const parsed = JSON.parse(bytes.toString('utf8'));
        assert.equal(parsed.schema, 'ck-core-compatibility-results');
        assert.equal(parsed.version, 1);
        assert.equal(parsed.replaced, expectedReplaced);
    }

    assert.deepEqual((await readdir(reportRoot)).sort(), ['created.json', 'replaced.json']);
});
