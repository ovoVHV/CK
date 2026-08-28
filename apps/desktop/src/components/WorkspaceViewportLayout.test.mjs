import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import tailwindcss from '@tailwindcss/postcss';
import WebSocket from 'ws';

const componentDirectory = path.dirname(fileURLToPath(import.meta.url));
const sourceDirectory = path.resolve(componentDirectory, '..');
const workspacePath = path.join(componentDirectory, 'Workspace.tsx');
const appPath = path.join(sourceDirectory, 'App.tsx');
const stylesheetPath = path.join(sourceDirectory, 'index.css');

const [workspaceSource, appSource, stylesheetSource] = await Promise.all([
    readFile(workspacePath, 'utf8'),
    readFile(appPath, 'utf8'),
    readFile(stylesheetPath, 'utf8'),
]);

function classNameContaining(source, marker) {
    const markerIndex = source.indexOf(marker);
    assert.ok(markerIndex >= 0, `expected class marker ${marker}`);

    const attributeIndex = source.lastIndexOf('className=', markerIndex);
    assert.ok(attributeIndex >= 0, `expected className for ${marker}`);
    let quoteIndex = attributeIndex + 'className='.length;
    if (source[quoteIndex] === '{') quoteIndex += 1;
    const quote = source[quoteIndex];
    assert.ok(quote === '"' || quote === '`', `expected a literal className for ${marker}`);

    const endIndex = source.indexOf(quote, quoteIndex + 1);
    assert.ok(endIndex > markerIndex, `expected closing className quote for ${marker}`);
    return source
        .slice(quoteIndex + 1, endIndex)
        .replace(/\$\{[^}]*\}/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function hasClass(className, expected) {
    return className.split(/\s+/).includes(expected);
}

const layoutClasses = {
    shell: classNameContaining(workspaceSource, 'ck-workspace-shell'),
    header: classNameContaining(workspaceSource, 'ck-workspace-header'),
    main: classNameContaining(workspaceSource, 'ck-workspace-main'),
    stage: classNameContaining(workspaceSource, 'ck-workspace-stage'),
};

test('workspace fullscreen structure has no width cap and every flex child may shrink', () => {
    assert.match(appSource, /className="app-root[^"\n]*"/);
    assert.match(appSource, /maxWidth:\s*'100%'/);
    assert.match(appSource, /width:\s*'100vw'/);
    assert.match(appSource, /height:\s*'100vh'/);
    assert.match(appSource, /padding:\s*0/);
    assert.match(appSource, /margin:\s*0/);
    assert.match(appSource, /overflow:\s*'hidden'/);

    for (const expected of ['h-full', 'w-full', 'min-w-0', 'flex', 'flex-col', 'overflow-hidden']) {
        assert.ok(hasClass(layoutClasses.shell, expected), `workspace shell must retain ${expected}`);
    }
    for (const expected of ['flex', 'shrink-0']) {
        assert.ok(hasClass(layoutClasses.header, expected), `workspace header must retain ${expected}`);
    }
    for (const expected of ['flex', 'flex-1', 'min-w-0', 'w-full', 'max-w-full', 'overflow-hidden']) {
        assert.ok(hasClass(layoutClasses.main, expected), `workspace main must retain ${expected}`);
    }
    for (const expected of ['flex', 'flex-1', 'min-w-0', 'overflow-hidden']) {
        assert.ok(hasClass(layoutClasses.stage, expected), `workspace stage must retain ${expected}`);
    }

    assert.match(stylesheetSource, /body\s*\{[\s\S]*?margin:\s*0\s*;/);
    assert.doesNotMatch(layoutClasses.shell, /(?:^|\s)max-w-\[(?!100%)/);
    assert.doesNotMatch(layoutClasses.main, /(?:^|\s)w-\[(?!100%)/);
    assert.doesNotMatch(layoutClasses.stage, /(?:^|\s)w-\[(?!100%)/);
});

async function firstAccessiblePath(candidates) {
    for (const candidate of candidates) {
        if (!candidate) continue;
        try {
            await access(candidate);
            return candidate;
        } catch {
            // Try the next known browser location.
        }
    }
    return null;
}

async function findIsolatedBrowser() {
    if (process.env.CK_LAYOUT_TEST_BROWSER) {
        return firstAccessiblePath([process.env.CK_LAYOUT_TEST_BROWSER]);
    }
    if (process.platform === 'win32') {
        return firstAccessiblePath([
            path.join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
            path.join(process.env.PROGRAMFILES || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
            path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        ]);
    }
    return firstAccessiblePath([
        '/usr/bin/google-chrome',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
    ]);
}

async function reservePort() {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            const port = typeof address === 'object' && address ? address.port : null;
            server.close(error => {
                if (error) reject(error);
                else if (port == null) reject(new Error('failed to reserve a browser debugging port'));
                else resolve(port);
            });
        });
    });
}

async function waitForBrowserEndpoint(port, browserProcess) {
    const endpoint = `http://127.0.0.1:${port}/json/version`;
    let lastError;
    for (let attempt = 0; attempt < 100; attempt += 1) {
        if (browserProcess.exitCode != null) {
            throw new Error(`isolated layout browser exited with code ${browserProcess.exitCode}`);
        }
        try {
            const response = await fetch(endpoint);
            if (response.ok) return;
        } catch (error) {
            lastError = error;
        }
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`isolated layout browser did not expose CDP: ${String(lastError || 'timeout')}`);
}

async function openCdpClient(port) {
    const response = await fetch(`http://127.0.0.1:${port}/json/new?about%3Ablank`, { method: 'PUT' });
    assert.ok(response.ok, `failed to create isolated browser target: ${response.status}`);
    const target = await response.json();
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
    });

    let requestId = 0;
    const pending = new Map();
    socket.on('message', raw => {
        const message = JSON.parse(raw.toString());
        if (!message.id || !pending.has(message.id)) return;
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result || {});
    });

    return {
        close: () => socket.close(),
        send(method, params = {}) {
            return new Promise((resolve, reject) => {
                requestId += 1;
                pending.set(requestId, { resolve, reject });
                socket.send(JSON.stringify({ id: requestId, method, params }));
            });
        },
    };
}

function layoutFixture(css) {
    const appStyle = [
        'max-width:100%',
        'padding:0',
        'margin:0',
        'height:100vh',
        'width:100vw',
        'display:flex',
        'flex-direction:column',
        'overflow:hidden',
    ].join(';');
    return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>${css}</style>
</head>
<body>
<div id="root">
  <div class="app-root" style="${appStyle}" data-layout-role="app-root">
    <div class="${layoutClasses.shell}" data-layout-role="workspace-root">
      <header class="${layoutClasses.header}" data-layout-role="top-bar"></header>
      <div class="${layoutClasses.main}" data-layout-role="workspace-main">
        <div class="${layoutClasses.stage}" data-layout-role="editor-stage">
          <div class="absolute inset-0"></div>
        </div>
      </div>
    </div>
  </div>
</div>
</body>
</html>`;
}

test('isolated DOM fills 1024 through 2048px viewports without a right gap or horizontal overflow', async t => {
    const browserExecutable = await findIsolatedBrowser();
    if (!browserExecutable) {
        t.skip('Edge/Chrome is unavailable; static fullscreen contract still ran');
        return;
    }

    // Compile only the exact production utility classes used by the layout fixture.
    // Processing the whole application stylesheet makes Tailwind scan every source file,
    // which is unnecessary for this geometry check and can consume several gigabytes in
    // a constrained release-validation machine.
    const fixtureUtilities = [...new Set(
        Object.values(layoutClasses)
            .flatMap(className => className.split(/\s+/))
            .filter(Boolean),
    )].join(' ');
    const fixtureStylesheet = [
        '@import "tailwindcss" source(none);',
        `@source inline("${fixtureUtilities}");`,
        'html, body, #root { width: 100%; height: 100%; margin: 0; overflow: hidden; }',
    ].join('\n');
    const compiled = await postcss([tailwindcss()]).process(fixtureStylesheet, {
        from: path.join(sourceDirectory, '__viewport_layout_fixture.css'),
    });
    const html = layoutFixture(compiled.css);
    const dataUrl = `data:text/html;base64,${Buffer.from(html).toString('base64')}`;
    const profileDirectory = await mkdtemp(path.join(tmpdir(), 'ck-layout-browser-'));
    const port = await reservePort();
    const browserProcess = spawn(browserExecutable, [
        '--headless=new',
        '--disable-background-networking',
        '--disable-default-apps',
        '--disable-extensions',
        '--disable-gpu',
        '--no-default-browser-check',
        '--no-first-run',
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profileDirectory}`,
        'about:blank',
    ], { stdio: 'ignore', windowsHide: true });

    let client;
    try {
        await waitForBrowserEndpoint(port, browserProcess);
        client = await openCdpClient(port);
        await client.send('Page.enable');
        await client.send('Runtime.enable');

        for (const width of [1024, 1366, 1920, 2048]) {
            await t.test(`${width}px`, async () => {
                await client.send('Emulation.setDeviceMetricsOverride', {
                    width,
                    height: 800,
                    deviceScaleFactor: 1,
                    mobile: false,
                });
                await client.send('Page.navigate', { url: dataUrl });

                let ready = false;
                for (let attempt = 0; attempt < 50 && !ready; attempt += 1) {
                    const state = await client.send('Runtime.evaluate', {
                        expression: 'document.readyState',
                        returnByValue: true,
                    });
                    ready = state.result?.value === 'complete';
                    if (!ready) await new Promise(resolve => setTimeout(resolve, 20));
                }
                assert.ok(ready, `${width}px fixture should finish loading`);

                const evaluated = await client.send('Runtime.evaluate', {
                    expression: `(() => {
                        const bounds = role => {
                            const rect = document.querySelector('[data-layout-role="' + role + '"]').getBoundingClientRect();
                            return { left: rect.left, right: rect.right, width: rect.width };
                        };
                        return {
                            innerWidth: window.innerWidth,
                            clientWidth: document.documentElement.clientWidth,
                            documentScrollWidth: document.documentElement.scrollWidth,
                            bodyScrollWidth: document.body.scrollWidth,
                            app: bounds('app-root'),
                            root: bounds('workspace-root'),
                            header: bounds('top-bar'),
                            main: bounds('workspace-main'),
                            stage: bounds('editor-stage'),
                        };
                    })()`,
                    returnByValue: true,
                });
                const geometry = evaluated.result.value;
                assert.equal(geometry.innerWidth, width);
                assert.equal(geometry.clientWidth, width);
                assert.ok(geometry.documentScrollWidth <= width, `document overflowed at ${width}px: ${geometry.documentScrollWidth}px`);
                assert.ok(geometry.bodyScrollWidth <= width, `body overflowed at ${width}px: ${geometry.bodyScrollWidth}px`);

                for (const [name, rect] of Object.entries({
                    app: geometry.app,
                    root: geometry.root,
                    header: geometry.header,
                    main: geometry.main,
                    stage: geometry.stage,
                })) {
                    assert.ok(Math.abs(rect.left) <= 0.5, `${name} left edge drifted at ${width}px: ${rect.left}px`);
                    assert.ok(Math.abs(width - rect.right) <= 0.5, `${name} left a right gap at ${width}px: ${width - rect.right}px`);
                    assert.ok(Math.abs(width - rect.width) <= 0.5, `${name} did not fill ${width}px: ${rect.width}px`);
                }
            });
        }
    } finally {
        client?.close();
        browserProcess.kill();
        await new Promise(resolve => {
            if (browserProcess.exitCode != null) resolve();
            else browserProcess.once('exit', resolve);
            setTimeout(resolve, 1000);
        });
        // Edge can keep a profile database handle for a few milliseconds after
        // the headless parent exits on Windows. Retry cleanup so a successful
        // geometry assertion is not reported as a product failure.
        await rm(profileDirectory, {
            recursive: true,
            force: true,
            maxRetries: 20,
            retryDelay: 100,
        });
    }
});
