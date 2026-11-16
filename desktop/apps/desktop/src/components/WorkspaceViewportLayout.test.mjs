import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
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
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
        // Edge may hand the unique-profile launch to a child process and let
        // the small bootstrap parent exit successfully. Keep probing the CDP
        // endpoint in that case; only a non-zero exit is immediately fatal.
        if (browserProcess.exitCode != null && browserProcess.exitCode !== 0) {
            throw new Error(`isolated layout browser exited with code ${browserProcess.exitCode}`);
        }
        try {
            const response = await fetch(endpoint, { signal: AbortSignal.timeout(250) });
            if (response.ok) return;
        } catch (error) {
            lastError = error;
        }
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`isolated layout browser did not expose CDP: ${String(lastError || 'timeout')}`);
}

async function openCdpClient(port) {
    const response = await fetch(`http://127.0.0.1:${port}/json/new?about%3Ablank`, {
        method: 'PUT',
        signal: AbortSignal.timeout(5000),
    });
    assert.ok(response.ok, `failed to create isolated browser target: ${response.status}`);
    const target = await response.json();
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            socket.terminate();
            reject(new Error('timed out connecting to isolated browser CDP'));
        }, 5000);
        socket.once('open', resolve);
        socket.once('error', reject);
        socket.once('open', () => clearTimeout(timer));
        socket.once('error', () => clearTimeout(timer));
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
                const id = requestId;
                const timer = setTimeout(() => {
                    pending.delete(id);
                    reject(new Error(`timed out waiting for CDP ${method}`));
                }, 5000);
                pending.set(id, {
                    resolve: value => {
                        clearTimeout(timer);
                        resolve(value);
                    },
                    reject: error => {
                        clearTimeout(timer);
                        reject(error);
                    },
                });
                socket.send(JSON.stringify({ id: requestId, method, params }));
            });
        },
    };
}

async function terminateIsolatedBrowser(browserProcess) {
    if (!browserProcess || browserProcess.exitCode != null) return;
    if (process.platform === 'win32' && browserProcess.pid) {
        await new Promise(resolve => {
            const killer = spawn('taskkill', [
                '/PID', String(browserProcess.pid), '/T', '/F',
            ], { stdio: 'ignore', windowsHide: true });
            const timer = setTimeout(resolve, 5000);
            killer.once('exit', () => {
                clearTimeout(timer);
                resolve();
            });
            killer.once('error', () => {
                clearTimeout(timer);
                resolve();
            });
        });
        return;
    }
    browserProcess.kill('SIGKILL');
}

function scheduleProfileCleanup(profileDirectory) {
    const target = path.resolve(profileDirectory);
    const tempRoot = path.resolve(tmpdir());
    assert.ok(
        target.startsWith(`${tempRoot}${path.sep}`)
        && path.basename(target).startsWith('ck-layout-browser-'),
        `refusing to clean unexpected browser profile path: ${target}`,
    );
    // Edge can retain profile handles briefly after its parent process exits.
    // A detached, exact-path Node cleanup keeps that Windows delay out of the
    // test lifecycle while still removing only this verified temporary folder.
    const cleanupSource = `setTimeout(() => require('node:fs/promises').rm(${JSON.stringify(target)}, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 }).catch(() => {}), 250);`;
    const cleanup = spawn(process.execPath, ['-e', cleanupSource], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
    });
    cleanup.unref();
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

    // This is a geometry test, so reproduce only the production utility
    // declarations that participate in sizing. Running Tailwind/PostCSS here
    // makes the test scan the entire growing application and can leave the
    // release suite waiting minutes for a dozen deterministic declarations.
    const fixtureCss = `
      html, body, #root { width: 100%; height: 100%; margin: 0; overflow: hidden; }
      .h-full { height: 100%; }
      .w-full { width: 100%; }
      .max-w-full { max-width: 100%; }
      .min-w-0 { min-width: 0; }
      .flex { display: flex; }
      .flex-col { flex-direction: column; }
      .flex-1 { flex: 1 1 0%; }
      .shrink-0 { flex-shrink: 0; }
      .overflow-hidden { overflow: hidden; }
      .relative { position: relative; }
      .absolute { position: absolute; }
      .inset-0 { inset: 0; }
    `;
    const html = layoutFixture(fixtureCss);
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
        if (client) {
            await client.send('Browser.close').catch(() => undefined);
        }
        client?.close();
        await terminateIsolatedBrowser(browserProcess);
        await new Promise(resolve => {
            if (browserProcess.exitCode != null) resolve();
            else browserProcess.once('exit', resolve);
            setTimeout(resolve, 1000);
        });
        scheduleProfileCleanup(profileDirectory);
    }
});
