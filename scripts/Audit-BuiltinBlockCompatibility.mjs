#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, '..');
const desktopRoot = join(root, 'apps', 'desktop');
const componentRoot = join(desktopRoot, 'src', 'components');
const setupPath = join(componentRoot, 'blockly_setup.ts');
const generatorPath = join(componentRoot, 'arduino_generator.ts');
const workspacePath = join(componentRoot, 'Workspace.tsx');
const defaultCatalogPath = join(root, 'docs', 'compatibility', 'builtin-block-compatibility.json');
const requireFromDesktop = createRequire(join(desktopRoot, 'package.json'));
const { build } = requireFromDesktop('esbuild');

const argumentValue = name => {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : undefined;
};

const outputPath = argumentValue('--out');
const fixtureRoot = argumentValue('--emit-fixtures');
const catalogPath = resolve(argumentValue('--catalog') || defaultCatalogPath);

const rootRelativePath = (candidate, label) => {
    const relativePath = relative(root, resolve(candidate));
    if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
        throw new Error(`${label} must stay inside the CK root`);
    }
    return relativePath.split(sep).join('/');
};

let resolvedFixtureRoot;
if (fixtureRoot) {
    const lexicalFixtureRoot = resolve(fixtureRoot);
    rootRelativePath(lexicalFixtureRoot, 'Fixture output');
    await mkdir(lexicalFixtureRoot, { recursive: true });
    const [canonicalRoot, canonicalFixtureRoot] = await Promise.all([
        realpath(root),
        realpath(lexicalFixtureRoot),
    ]);
    const canonicalRelative = relative(canonicalRoot, canonicalFixtureRoot);
    if (!canonicalRelative || canonicalRelative === '..' || canonicalRelative.startsWith(`..${sep}`) || isAbsolute(canonicalRelative)) {
        throw new Error('Fixture output must stay inside the CK root');
    }
    resolvedFixtureRoot = canonicalFixtureRoot;
}

const extractUnique = (source, pattern) => Array.from(
    new Set(Array.from(source.matchAll(pattern), match => match[1])),
).sort();

const sha256 = value => createHash('sha256').update(value).digest('hex');

const assertPublishedReportPrivacy = serialized => {
    const forbidden = [
        /[A-Za-z]:[\\/]/,
        /\\\\[^\\\s]+[\\/]/,
        /\bfile:\/\//i,
        /\b(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b/i,
        /\b[0-9a-f]{4}(?:\.[0-9a-f]{4}){2}\b/i,
        /\bmac(?:\s+address)?\s*[:=]\s*[0-9a-f]{12}\b/i,
    ];
    if (forbidden.some(pattern => pattern.test(serialized))) {
        throw new Error('Compatibility audit report contains a sensitive absolute path, file URI, or full MAC');
    }
};

const setupSource = await readFile(setupPath, 'utf8');
const generatorSource = await readFile(generatorPath, 'utf8');
const workspaceSource = await readFile(workspacePath, 'utf8');
const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
const staticToolboxTypes = extractUnique(setupSource, /<(?:block|shadow)\s+type="([^"]+)"/g);
const functionFlyoutMatch = workspaceSource.match(
    /const CK_FUNCTION_FLYOUT_BLOCK_TYPES\s*=\s*\[([\s\S]*?)\];/,
);
if (!functionFlyoutMatch) throw new Error('Cannot locate CK_FUNCTION_FLYOUT_BLOCK_TYPES');
const dynamicToolboxTypes = extractUnique(functionFlyoutMatch[1], /['"]([^'"]+)['"]/g);
const toolboxTypes = Array.from(new Set([...staticToolboxTypes, ...dynamicToolboxTypes])).sort();
const generatorTypes = extractUnique(
    generatorSource,
    /arduinoGenerator\.forBlock\[['"]([^'"]+)['"]\]/g,
);

const missingGenerators = toolboxTypes.filter(type => !generatorTypes.includes(type));
if (missingGenerators.length > 0) {
    throw new Error(`Toolbox blocks without a static generator reference: ${missingGenerators.join(', ')}`);
}

const catalogTypes = Array.from(new Set(catalog.blocks || [])).sort();
const catalogOnly = catalogTypes.filter(type => !toolboxTypes.includes(type));
const toolboxOnly = toolboxTypes.filter(type => !catalogTypes.includes(type));
if (catalogOnly.length > 0 || toolboxOnly.length > 0) {
    throw new Error([
        `Compatibility catalog drift in ${catalogPath}`,
        catalogOnly.length ? `catalog-only: ${catalogOnly.join(', ')}` : '',
        toolboxOnly.length ? `toolbox-only: ${toolboxOnly.join(', ')}` : '',
    ].filter(Boolean).join('\n'));
}

const targetIds = new Set((catalog.targets || []).map(target => target.id));
const ruleByType = new Map();
for (const rule of catalog.architectureRules || []) {
    for (const targetId of [...(rule.supportedTargets || []), ...(rule.unsupportedTargets || [])]) {
        if (!targetIds.has(targetId)) throw new Error(`Unknown target ${targetId} in ${rule.classification}`);
    }
    for (const type of rule.types || []) {
        if (!catalogTypes.includes(type)) throw new Error(`Unknown block ${type} in ${rule.classification}`);
        if (ruleByType.has(type)) throw new Error(`Block ${type} has more than one architecture rule`);
        ruleByType.set(type, rule);
    }
}
for (const suite of catalog.representativeCompileSuites || []) {
    for (const targetId of suite.targets || []) {
        if (!targetIds.has(targetId)) throw new Error(`Unknown target ${targetId} in suite ${suite.id}`);
    }
    for (const type of suite.blocks || []) {
        if (!catalogTypes.includes(type)) throw new Error(`Unknown block ${type} in suite ${suite.id}`);
    }
}

const bundlePath = join(
    componentRoot,
    `.ck-builtin-block-audit-${process.pid}-${Date.now()}.tmp.mjs`,
);

await build({
    stdin: {
        contents: [
            "import * as Blockly from 'blockly';",
            "import 'blockly/blocks';",
            "import './blockly_setup.ts';",
            "export { Blockly };",
            "export { arduinoGenerator, setArduinoGeneratorTarget } from './arduino_generator.ts';",
        ].join('\n'),
        resolveDir: componentRoot,
        sourcefile: 'builtin-block-audit-entry.ts',
        loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    packages: 'external',
    target: 'node20',
    outfile: bundlePath,
    logLevel: 'silent',
});

let runtime;
const runtimeLogs = [];
const originalConsoleLog = console.log;
try {
    console.log = (...args) => runtimeLogs.push(args.map(String).join(' '));
    runtime = await import(`${pathToFileURL(bundlePath).href}?v=${Date.now()}`);
} finally {
    console.log = originalConsoleLog;
    await unlink(bundlePath).catch(() => undefined);
}

const runtimeGeneratorTypes = Object.keys(runtime.arduinoGenerator.forBlock || {})
    .filter(type => typeof runtime.arduinoGenerator.forBlock[type] === 'function')
    .sort();
const missingRuntimeGenerators = toolboxTypes.filter(type => !runtimeGeneratorTypes.includes(type));
if (missingRuntimeGenerators.length > 0) {
    throw new Error(`Toolbox blocks without a runtime generator: ${missingRuntimeGenerators.join(', ')}`);
}

const targets = catalog.targets;

const compileSuitesFor = (type, targetId) => (catalog.representativeCompileSuites || [])
    .filter(suite => suite.targets.includes(targetId) && suite.blocks.includes(type))
    .map(suite => suite.id);

const compatibilityFor = (type, targetId) => {
    const rule = ruleByType.get(type);
    if (!rule) {
        return {
            classification: catalog.defaultRule.classification,
            architectureAvailability: catalog.defaultRule.supportedTargets.includes(targetId)
                ? 'supported'
                : 'unsupported',
        };
    }
    return {
        classification: rule.classification,
        architectureAvailability: rule.supportedTargets.includes(targetId) ? 'supported' : 'unsupported',
    };
};

const results = [];
for (const target of targets) {
    runtime.setArduinoGeneratorTarget(target.fqbn, target.coreVersion);
    for (const type of toolboxTypes) {
        const workspace = new runtime.Blockly.Workspace();
        try {
            const block = workspace.newBlock(type, `audit-${target.id}-${type}`);
            const code = runtime.arduinoGenerator.workspaceToCode(workspace);
            const compatibility = compatibilityFor(type, target.id);
            const compileOnlySuites = compileSuitesFor(type, target.id);
            results.push({
                target: target.id,
                type,
                status: 'pass',
                ...compatibility,
                compileOnlySuites,
                compileEvidence: compatibility.architectureAvailability === 'unsupported'
                    ? 'not-applicable'
                    : compileOnlySuites.length > 0
                        ? 'representative-suite-defined-awaiting-compile'
                        : 'no-compile-evidence',
                hardwareTested: false,
                codeBytes: Buffer.byteLength(code),
                codeSha256: sha256(code),
                blockShape: block.outputConnection
                    ? 'value'
                    : block.previousConnection
                        ? 'statement'
                        : 'structural',
            });
        } catch (error) {
            results.push({
                target: target.id,
                type,
                status: 'fail',
                error: error instanceof Error ? error.message : String(error),
            });
        } finally {
            workspace.dispose();
        }
    }
}

let fixtureManifest = [];
if (resolvedFixtureRoot) {
    let blockSequence = 0;
    const makeBlock = (workspace, type, fields = {}) => {
        blockSequence += 1;
        const block = workspace.newBlock(type, `compat-${blockSequence}-${type}`);
        for (const [name, value] of Object.entries(fields)) {
            block.setFieldValue(String(value), name);
        }
        return block;
    };
    const connectValue = (parent, inputName, child) => {
        const input = parent.getInput(inputName);
        if (!input?.connection || !child.outputConnection) {
            throw new Error(`Cannot connect ${child.type} to ${parent.type}.${inputName}`);
        }
        input.connection.connect(child.outputConnection);
        return parent;
    };
    const chainStatements = (container, inputName, statements) => {
        const connection = container.getInput(inputName)?.connection;
        if (!connection || statements.length === 0) {
            throw new Error(`Cannot populate ${container.type}.${inputName}`);
        }
        connection.connect(statements[0].previousConnection);
        for (let index = 0; index < statements.length - 1; index += 1) {
            statements[index].nextConnection.connect(statements[index + 1].previousConnection);
        }
    };
    const numberBlock = (workspace, value) => makeBlock(workspace, 'math_number', { NUM: value });
    const textBlock = (workspace, value) => makeBlock(workspace, 'text', { TEXT: value });

    const buildPortableWorkspace = () => {
        const workspace = new runtime.Blockly.Workspace();
        const setup = makeBlock(workspace, 'controls_setup_custom');
        const serialSetup = makeBlock(workspace, 'serial_setup');
        connectValue(serialSetup, 'BAUD', numberBlock(workspace, 115200));
        const pinMode = makeBlock(workspace, 'set_pin_mode', { MODE: 'OUTPUT' });
        connectValue(pinMode, 'PIN', numberBlock(workspace, 13));
        chainStatements(setup, 'DO', [serialSetup, pinMode]);

        const loop = makeBlock(workspace, 'controls_loop_custom');
        const digitalWrite = makeBlock(workspace, 'write_digital');
        connectValue(digitalWrite, 'PIN', numberBlock(workspace, 13));
        connectValue(digitalWrite, 'LEVEL', makeBlock(workspace, 'io_level', { LEVEL: 'HIGH' }));

        const printText = makeBlock(workspace, 'serial_print', { NEWLINE: 'TRUE' });
        const concat = makeBlock(workspace, 'text_concat_custom');
        connectValue(concat, 'A', textBlock(workspace, 'tick='));
        connectValue(concat, 'B', makeBlock(workspace, 'control_system_runtime', { UNIT: 'MS' }));
        connectValue(printText, 'MSG', concat);

        const printAnalog = makeBlock(workspace, 'serial_print_number', { NEWLINE: 'TRUE', BASE: 'DEC' });
        const analogRead = makeBlock(workspace, 'io_analog_read');
        connectValue(analogRead, 'PIN', numberBlock(workspace, 0));
        connectValue(printAnalog, 'NUM', analogRead);

        const delay = makeBlock(workspace, 'control_delay', { UNIT: 'MS' });
        connectValue(delay, 'TIME', numberBlock(workspace, 25));
        chainStatements(loop, 'DO', [digitalWrite, printText, printAnalog, delay]);
        return workspace;
    };

    const buildEsp32NetworkWorkspace = () => {
        const workspace = new runtime.Blockly.Workspace();
        const setup = makeBlock(workspace, 'controls_setup_custom');
        const serialPins = makeBlock(workspace, 'serial_setup_with_pins', { PORT: 'Serial1' });
        connectValue(serialPins, 'BAUD', numberBlock(workspace, 115200));
        connectValue(serialPins, 'RX', numberBlock(workspace, 19));
        connectValue(serialPins, 'TX', numberBlock(workspace, 18));
        const wifiConnect = makeBlock(workspace, 'wifi_connect', {
            SSID: 'ck-compile-only',
            PASSWORD: 'not-a-network',
        });
        const wifiProtocol = makeBlock(workspace, 'wifi_set_protocol', {
            PROTOCOL: 'WIFI_PROTOCOL_11AX',
        });
        chainStatements(setup, 'DO', [serialPins, wifiConnect, wifiProtocol]);

        const loop = makeBlock(workspace, 'controls_loop_custom');
        const waitWifi = makeBlock(workspace, 'wifi_wait_until_ready');
        const printIp = makeBlock(workspace, 'serial_print', { NEWLINE: 'TRUE' });
        connectValue(printIp, 'MSG', makeBlock(workspace, 'wifi_local_ip'));
        const printRssi = makeBlock(workspace, 'serial_print_number', { NEWLINE: 'TRUE', BASE: 'DEC' });
        connectValue(printRssi, 'NUM', makeBlock(workspace, 'wifi_get_rssi'));
        const printChannel = makeBlock(workspace, 'serial_print_number', { NEWLINE: 'TRUE', BASE: 'DEC' });
        connectValue(printChannel, 'NUM', makeBlock(workspace, 'wifi_get_channel'));
        const delay = makeBlock(workspace, 'control_delay', { UNIT: 'MS' });
        connectValue(delay, 'TIME', numberBlock(workspace, 1000));
        chainStatements(loop, 'DO', [waitWifi, printIp, printRssi, printChannel, delay]);
        return workspace;
    };

    const buildPortableFunctionsWorkspace = () => {
        const workspace = new runtime.Blockly.Workspace();

        const voidDefinition = makeBlock(workspace, 'procedures_defnoreturn', { NAME: 'myFunction' });
        const conditionalVoidReturn = makeBlock(workspace, 'procedures_ifreturn_void_custom');
        connectValue(
            conditionalVoidReturn,
            'COND',
            makeBlock(workspace, 'logic_boolean', { BOOL: 'FALSE' }),
        );
        const voidReturn = makeBlock(workspace, 'procedures_return_void_custom');
        chainStatements(voidDefinition, 'STACK', [conditionalVoidReturn, voidReturn]);

        const valueDefinition = makeBlock(workspace, 'procedures_defreturn', {
            NAME: 'myValue',
            RET_TYPE: 'int',
        });
        const conditionalValueReturn = makeBlock(workspace, 'procedures_ifreturn_value_custom');
        connectValue(
            conditionalValueReturn,
            'COND',
            makeBlock(workspace, 'logic_boolean', { BOOL: 'FALSE' }),
        );
        connectValue(conditionalValueReturn, 'VALUE', numberBlock(workspace, 1));
        const valueReturn = makeBlock(workspace, 'procedures_return_value_custom');
        connectValue(valueReturn, 'VALUE', numberBlock(workspace, 2));
        chainStatements(valueDefinition, 'STACK', [conditionalValueReturn, valueReturn]);
        connectValue(valueDefinition, 'RETURN', numberBlock(workspace, 3));

        const loop = makeBlock(workspace, 'controls_loop_custom');
        const callVoid = makeBlock(workspace, 'procedures_callnoreturn_picker', { NAME: 'myFunction' });
        const printValue = makeBlock(workspace, 'serial_print_number', {
            NEWLINE: 'TRUE',
            BASE: 'DEC',
        });
        connectValue(
            printValue,
            'NUM',
            makeBlock(workspace, 'procedures_callreturn_picker', { NAME: 'myValue' }),
        );
        chainStatements(loop, 'DO', [callVoid, printValue]);
        return workspace;
    };

    const buildPortableTimingIoWorkspace = () => {
        const workspace = new runtime.Blockly.Workspace();
        const setup = makeBlock(workspace, 'controls_setup_custom');
        const timerEvery = makeBlock(workspace, 'control_mstimer2_every');
        connectValue(timerEvery, 'INTERVAL', numberBlock(workspace, 250));
        chainStatements(setup, 'DO', [timerEvery]);

        const loop = makeBlock(workspace, 'controls_loop_custom');
        const timerStart = makeBlock(workspace, 'control_mstimer2_start');
        const timerStop = makeBlock(workspace, 'control_mstimer2_stop');

        const printPulse = makeBlock(workspace, 'serial_print_number', {
            NEWLINE: 'TRUE',
            BASE: 'DEC',
        });
        const pulseLong = makeBlock(workspace, 'io_pulse_in_long');
        connectValue(pulseLong, 'PIN', numberBlock(workspace, 2));
        connectValue(pulseLong, 'STATE', makeBlock(workspace, 'io_level', { LEVEL: 'HIGH' }));
        connectValue(pulseLong, 'TIMEOUT', numberBlock(workspace, 1000));
        connectValue(printPulse, 'NUM', pulseLong);

        const hardwareInterrupt = makeBlock(workspace, 'io_hardware_interrupt_event', { MODE: 'RISING' });
        connectValue(hardwareInterrupt, 'PIN', numberBlock(workspace, 2));
        const hardwareDetach = makeBlock(workspace, 'io_hardware_interrupt_detach');
        connectValue(hardwareDetach, 'PIN', numberBlock(workspace, 2));

        const softwareInterrupt = makeBlock(workspace, 'io_software_interrupt_event', { MODE: 'FALLING' });
        connectValue(softwareInterrupt, 'PIN', numberBlock(workspace, 3));
        const softwareCancel = makeBlock(workspace, 'io_software_interrupt_cancel');
        connectValue(softwareCancel, 'PIN', numberBlock(workspace, 3));

        chainStatements(loop, 'DO', [
            timerStart,
            printPulse,
            hardwareInterrupt,
            hardwareDetach,
            softwareInterrupt,
            softwareCancel,
            timerStop,
        ]);
        return workspace;
    };

    const fixtureSpecs = [
        { suite: 'portable-core', target: 'avr-nano', buildWorkspace: buildPortableWorkspace },
        { suite: 'portable-core', target: 'esp32-c6', buildWorkspace: buildPortableWorkspace },
        { suite: 'esp32-network', target: 'esp32-c6', buildWorkspace: buildEsp32NetworkWorkspace },
        { suite: 'portable-functions', target: 'avr-nano', buildWorkspace: buildPortableFunctionsWorkspace },
        { suite: 'portable-functions', target: 'esp32-c6', buildWorkspace: buildPortableFunctionsWorkspace },
        { suite: 'portable-timing-io', target: 'avr-nano', buildWorkspace: buildPortableTimingIoWorkspace },
        { suite: 'portable-timing-io', target: 'esp32-c6', buildWorkspace: buildPortableTimingIoWorkspace },
    ];
    for (const spec of fixtureSpecs) {
        const target = targets.find(candidate => candidate.id === spec.target);
        runtime.setArduinoGeneratorTarget(target.fqbn, target.coreVersion);
        const workspace = spec.buildWorkspace();
        try {
            const name = `${spec.suite.replaceAll('-', '_')}_${spec.target.replaceAll('-', '_')}`;
            const directory = join(resolvedFixtureRoot, name);
            const sketchPath = join(directory, `${name}.ino`);
            const code = runtime.arduinoGenerator.workspaceToCode(workspace);
            await mkdir(directory, { recursive: true });
            await writeFile(sketchPath, code, 'utf8');
            fixtureManifest.push({
                suite: spec.suite,
                target: spec.target,
                fqbn: target.fqbn,
                coreVersion: target.coreVersion,
                directory: rootRelativePath(directory, 'Fixture directory'),
                sketchPath: rootRelativePath(sketchPath, 'Fixture sketch'),
                codeBytes: Buffer.byteLength(code),
                codeSha256: sha256(code),
                evidence: 'generated-source-awaiting-compile-only',
                hardwareTested: false,
            });
        } finally {
            workspace.dispose();
        }
    }
}

const failures = results.filter(result => result.status === 'fail');
const report = {
    schema: 'ck-builtin-block-generator-audit',
    version: 1,
    evidence: 'static-generation-only',
    hardwareTested: false,
    source: {
        catalog: 'docs/compatibility/builtin-block-compatibility.json',
        toolbox: 'apps/desktop/src/components/blockly_setup.ts',
        dynamicToolbox: 'apps/desktop/src/components/Workspace.tsx#CK_FUNCTION_FLYOUT_BLOCK_TYPES',
        generator: 'apps/desktop/src/components/arduino_generator.ts',
    },
    runtimeLogs,
    counts: {
        toolboxTypes: toolboxTypes.length,
        staticToolboxTypes: staticToolboxTypes.length,
        dynamicToolboxTypes: dynamicToolboxTypes.length,
        staticGeneratorReferences: generatorTypes.length,
        registeredGeneratorTypes: runtimeGeneratorTypes.length,
        targetRuns: results.length,
        passed: results.length - failures.length,
        failed: failures.length,
    },
    targets,
    architectureRules: catalog.architectureRules,
    representativeCompileSuites: catalog.representativeCompileSuites,
    fixtures: fixtureManifest,
    results,
};

const serializedReport = `${JSON.stringify(report, null, 2)}\n`;
assertPublishedReportPrivacy(serializedReport);
if (outputPath) {
    const resolvedOutputPath = resolve(outputPath);
    await mkdir(dirname(resolvedOutputPath), { recursive: true });
    await writeFile(resolvedOutputPath, serializedReport, 'utf8');
    process.stdout.write(
        `builtin_block_generator_audit=${failures.length === 0 ? 'ok' : 'fail'} `
        + `blocks=${toolboxTypes.length} target_runs=${results.length} report=${resolvedOutputPath}\n`,
    );
} else {
    process.stdout.write(serializedReport);
}
if (failures.length > 0) process.exitCode = 1;
