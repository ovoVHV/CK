import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

const source = await readFile(new URL('./blockly_visual_skin.ts', import.meta.url), 'utf8');
const transpiled = ts.transpileModule(source, {
    compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
    },
    fileName: 'blockly_visual_skin.ts',
    reportDiagnostics: true,
});
assert.deepEqual(
    (transpiled.diagnostics || []).filter(item => item.category === ts.DiagnosticCategory.Error),
    [],
);
const skin = await import(
    `data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString('base64')}`
);

const rgb = value => {
    const match = String(value).match(/^#([0-9a-f]{6})$/i);
    assert.ok(match, `expected a six-digit hex colour, received ${value}`);
    return [0, 2, 4].map(index => Number.parseInt(match[1].slice(index, index + 2), 16));
};

const luminance = channels => {
    const linear = channels.map(channel => {
        const value = channel / 255;
        return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
};

const contrast = (left, right) => {
    const [lighter, darker] = [luminance(rgb(left)), luminance(rgb(right))].sort((a, b) => b - a);
    return (lighter + 0.05) / (darker + 0.05);
};

const withSvgDom = (markup, run) => {
    const dom = new JSDOM(markup);
    const previousElement = globalThis.Element;
    const previousDocument = globalThis.document;
    globalThis.Element = dom.window.Element;
    globalThis.document = dom.window.document;
    try {
        return run(dom.window.document);
    } finally {
        globalThis.Element = previousElement;
        globalThis.document = previousDocument;
        dom.window.close();
    }
};

test('every semantic role keeps readable labels across every non-original skin', () => {
    const styles = ['pastel', 'arcade', 'sticker', 'neon', 'mono'];
    const roleTypes = [
        'ck_setup_event',
        'controls_if',
        'controls_repeat_ext',
        'ck_hw_mpu6050_read',
        'ck_wait_ms',
        'text',
        'math_number',
        'variables_set',
        'wifi_connect',
        'ck_serial_print',
        'play_tone',
    ];
    for (const style of styles) {
        for (const blockType of roleTypes) {
            const colour = skin.resolveBlocklySkinColour('#4169e1', blockType, style);
            const surface = skin.resolveBlocklySkinLabelSurface(colour, style);
            const textColour = skin.resolveBlocklySkinTextColour(colour, style);
            assert.ok(
                contrast(surface, textColour) >= 4.5,
                `${style}/${blockType} must keep at least 4.5:1 label contrast`,
            );
        }
    }
});

test('each non-original skin keeps one stable block-label colour across semantic categories', () => {
    const styles = ['pastel', 'arcade', 'sticker', 'neon', 'mono'];
    const categorySamples = [
        ['ck_setup_event', '#22c55e'],
        ['controls_if', '#4f7de8'],
        ['controls_repeat_ext', '#8b5cf6'],
        ['ck_serial_print', '#14b8a6'],
        ['text', '#a16207'],
        ['variables_set', '#db2777'],
        ['math_number', '#65a30d'],
    ];

    const unstableStyles = [];
    for (const style of styles) {
        const labelColours = categorySamples.map(([blockType, baseColour]) => {
            const transformed = skin.resolveBlocklySkinColour(baseColour, blockType, style);
            return skin.resolveBlocklySkinTextColour(transformed, style);
        });
        if (new Set(labelColours).size !== 1) {
            unstableStyles.push({ style, labelColours });
        }
    }
    assert.deepEqual(
        unstableStyles,
        [],
        'a skin must not switch ordinary block labels between black and white by category',
    );
});

test('the three hero skins use different material paint paths', () => {
    assert.match(source, /style === 'sticker'[\s\S]*?createElementNS\(SVG_NAMESPACE, 'pattern'\)/);
    assert.match(source, /style === 'arcade'[\s\S]*?appendGradientStop/);
    assert.match(source, /style === 'neon'[\s\S]*?mixHex\(colour, \{ r: 3, g: 10, b: 26 \}, 0\.36\)/);
});

test('original restores a Blockly shadow to getColourSecondary instead of the primary block colour', () => {
    withSvgDom(`
        <svg xmlns="http://www.w3.org/2000/svg">
            <g class="blocklyBlock blocklyShadow">
                <path class="blocklyPath" fill="#4169e1"></path>
            </g>
        </svg>
    `, document => {
        const root = document.querySelector('.blocklyBlock');
        const path = document.querySelector('.blocklyPath');
        const block = {
            type: 'logic_boolean',
            getSvgRoot: () => root,
            getColour: () => '#4169e1',
            getColourSecondary: () => '#9db5ec',
            isShadow: () => true,
        };
        const workspace = {
            getAllBlocks: () => [block],
            getParentSvg: () => document.querySelector('svg'),
        };

        assert.equal(skin.applyBlocklyVisualSkin(workspace, 'sticker'), 1);
        assert.notEqual(path.getAttribute('fill'), '#9db5ec');
        assert.equal(skin.applyBlocklyVisualSkin(workspace, 'original'), 1);
        assert.equal(path.getAttribute('fill'), '#9db5ec');
        assert.equal(path.style.getPropertyValue('fill'), '');
        assert.equal(path.dataset.ckBaseFill, '#4169e1');
        assert.equal(path.dataset.ckBaseShadowFill, '#9db5ec');
    });
});

test('all five non-original skins give shadow blocks a distinct idempotent paint', () => {
    withSvgDom(`
        <svg xmlns="http://www.w3.org/2000/svg">
            <g id="real" class="blocklyBlock">
                <path class="blocklyPath" fill="#4169e1"></path>
            </g>
            <g id="shadow" class="blocklyBlock blocklyShadow">
                <path class="blocklyPath" fill="#4169e1"></path>
            </g>
        </svg>
    `, document => {
        const realRoot = document.querySelector('#real');
        const shadowRoot = document.querySelector('#shadow');
        const realPath = realRoot.querySelector('.blocklyPath');
        const shadowPath = shadowRoot.querySelector('.blocklyPath');
        const blocks = [
            {
                type: 'logic_boolean',
                getSvgRoot: () => realRoot,
                getColour: () => '#4169e1',
                isShadow: () => false,
            },
            {
                type: 'logic_boolean',
                getSvgRoot: () => shadowRoot,
                getColour: () => '#4169e1',
                getColourSecondary: () => '#9db5ec',
                isShadow: () => true,
            },
        ];
        const svg = document.querySelector('svg');
        const workspace = {
            getAllBlocks: () => blocks,
            getParentSvg: () => svg,
        };

        for (const style of ['pastel', 'arcade', 'sticker', 'neon', 'mono']) {
            assert.equal(skin.applyBlocklyVisualSkin(workspace, style), 2);
            const firstRealFill = realPath.getAttribute('fill');
            const firstShadowFill = shadowPath.getAttribute('fill');
            const firstShadowSurface = shadowRoot.style.getPropertyValue('--ck-block-skin-surface');
            const firstDefinitionCount = svg.querySelectorAll('defs[data-ck-block-skin-defs="true"] > *').length;

            assert.notEqual(firstShadowFill, firstRealFill, `${style} shadow fill must differ from a real block`);
            assert.notEqual(
                firstShadowSurface,
                realRoot.style.getPropertyValue('--ck-block-skin-surface'),
                `${style} shadow paint must remain visually subordinate to a real block`,
            );
            assert.equal(realPath.dataset.ckShadowBlock, 'false');
            assert.equal(shadowPath.dataset.ckShadowBlock, 'true');

            assert.equal(skin.applyBlocklyVisualSkin(workspace, style), 2);
            assert.equal(realPath.getAttribute('fill'), firstRealFill, `${style} real fill must be idempotent`);
            assert.equal(shadowPath.getAttribute('fill'), firstShadowFill, `${style} shadow fill must be idempotent`);
            assert.equal(
                shadowRoot.style.getPropertyValue('--ck-block-skin-surface'),
                firstShadowSurface,
                `${style} repeated painting must not compound the shadow transform`,
            );
            assert.equal(
                svg.querySelectorAll('defs[data-ck-block-skin-defs="true"] > *').length,
                firstDefinitionCount,
                `${style} repeated painting must not accumulate SVG paint definitions`,
            );
        }
    });
});

test('a pure DOM blocklyShadow is detected even before Blockly registers its block model', () => {
    withSvgDom(`
        <svg xmlns="http://www.w3.org/2000/svg">
            <g class="blocklyBlock blocklyShadow">
                <path class="blocklyPath" fill="#4169e1"></path>
            </g>
        </svg>
    `, document => {
        const path = document.querySelector('.blocklyPath');
        const workspace = {
            getAllBlocks: () => [],
            getParentSvg: () => document.querySelector('svg'),
        };
        const regular = skin.resolveBlocklySkinColour('#4169e1', undefined, 'pastel');
        const expectedShadow = skin.resolveBlocklyShadowSkinColour(regular, 'pastel');

        assert.equal(skin.applyBlocklyVisualSkin(workspace, 'pastel'), 1);
        assert.equal(path.dataset.ckShadowBlock, 'true');
        assert.equal(path.getAttribute('fill'), expectedShadow);
        assert.notEqual(path.getAttribute('fill'), regular);
    });
});

test('read-only and locked block roots receive the same global skin', () => {
    const dom = new JSDOM(`
        <svg xmlns="http://www.w3.org/2000/svg">
            <g class="logic_boolean blocklyBlock logic_blocks">
                <path class="blocklyPath" fill="#4169e1"></path>
            </g>
        </svg>
    `);
    const previousElement = globalThis.Element;
    const previousDocument = globalThis.document;
    globalThis.Element = dom.window.Element;
    globalThis.document = dom.window.document;
    try {
        const root = dom.window.document.querySelector('.blocklyBlock');
        const path = dom.window.document.querySelector('.blocklyPath');
        const block = {
            type: 'logic_boolean',
            getSvgRoot: () => root,
            getColour: () => '#4169e1',
        };
        const workspace = {
            getAllBlocks: () => [block],
            getParentSvg: () => dom.window.document.querySelector('svg'),
        };
        assert.equal(root.classList.contains('blocklyDraggable'), false);
        assert.equal(skin.applyBlocklyVisualSkin(workspace, 'pastel'), 1);
        assert.equal(path.dataset.ckVisualStyle, 'pastel');
        assert.equal(path.getAttribute('fill'), '#6687cf');

        root.classList.add('blocklyInsertionMarker');
        assert.equal(skin.applyBlocklyVisualSkin(workspace, 'neon'), 0);
        assert.equal(path.dataset.ckVisualStyle, 'pastel');
    } finally {
        globalThis.Element = previousElement;
        globalThis.document = previousDocument;
        dom.window.close();
    }
});

test('original skin leaves fresh Blockly DOM untouched', () => {
    withSvgDom('<svg xmlns="http://www.w3.org/2000/svg"><g class="blocklyBlock"><path class="blocklyPath" fill="#4169e1"/><g class="blocklyEditableField"><rect fill="#ffffff"/></g></g></svg>', document => {
        const root=document.querySelector('.blocklyBlock');const before=root.outerHTML;
        assert.equal(skin.applyBlocklyVisualSkinToRoots([root], 'original'),0);
        assert.equal(root.outerHTML,before);
        skin.applyBlocklyVisualSkinToRoots([root],'neon');
        assert.equal(skin.applyBlocklyVisualSkinToRoots([root],'original'),1);
        assert.equal(root.querySelector('.blocklyPath').getAttribute('fill'),'#4169e1');
    });
});

test('a parent block skin pass never repaints nested blocks fields', () => {
    withSvgDom('<svg xmlns="http://www.w3.org/2000/svg"><g id="parent" class="blocklyBlock"><path class="blocklyPath" fill="#4169e1"/><g class="blocklyEditableField"><rect id="own" fill="#ffffff"/></g><g id="child" class="blocklyBlock"><path class="blocklyPath" fill="#4169e1"/><g class="blocklyEditableField"><rect id="nested" fill="#ffffff"/></g></g></g></svg>', document => {
        const child=document.querySelector('#child');const before=child.outerHTML;
        skin.applyBlocklyVisualSkinToRoots([document.querySelector('#parent')],'neon');
        assert.equal(child.outerHTML,before);
        assert.equal(document.querySelector('#own').style.getPropertyValue('fill'),'#07152b');
        skin.applyBlocklyVisualSkinToRoots([child],'pastel');
        assert.equal(document.querySelector('#nested').style.getPropertyValue('fill'),'#fffaf2');
        assert.equal(document.querySelector('#own').style.getPropertyValue('fill'),'#07152b');
    });
});

test('underscored BLE and RF24 blocks keep one consistent network skin colour and DOM-only drag roots preserve block role', () => {
    for (const style of ['pastel', 'arcade', 'sticker', 'neon', 'mono']) {
        const bleBegin = skin.resolveBlocklySkinColour('#2563eb', 'emakefun_ble_begin', style);
        const bleSendText = skin.resolveBlocklySkinColour('#2563eb', 'emakefun_ble_send_text', style);
        const bleReadText = skin.resolveBlocklySkinColour('#2563eb', 'emakefun_ble_read_text', style);
        const rfSendText = skin.resolveBlocklySkinColour('#e65100', 'emakefun_rf24_send_text', style);
        assert.equal(bleSendText, bleBegin, `${style}: emakefun_ble_send_text must match emakefun_ble_begin`);
        assert.equal(bleReadText, bleBegin, `${style}: emakefun_ble_read_text must match emakefun_ble_begin`);
        assert.equal(rfSendText, bleBegin, `${style}: emakefun_rf24_send_text must stay in network role`);
    }
    withSvgDom('<svg xmlns="http://www.w3.org/2000/svg"><g class="emakefun_ble_send_text blocklyBlock blocklyDraggable"><path class="blocklyPath" fill="#2563eb"/></g></svg>', document => {
        const root = document.querySelector('.blocklyBlock');
        const path = document.querySelector('.blocklyPath');
        assert.equal(skin.applyBlocklyVisualSkinToRoots([root], 'sticker'), 1);
        const firstFill = path.getAttribute('fill');
        assert.equal(path.dataset.ckBaseFill, '#2563eb');
        // Repainting when fill is already url(#ck-skin-...) must never corrupt ckBaseFill or colour.
        delete path.dataset.ckBaseFill;
        path.setAttribute('fill', firstFill);
        assert.equal(skin.applyBlocklyVisualSkinToRoots([root], 'sticker'), 0);
    });
});
