// @ts-nocheck
import * as Blockly from 'blockly';
import {
    createBlockMarkerComment,
    stripBlockMarkerComments,
} from '../services/block_markers';
import {
    compileSourceMapToLegacyLineMap,
    freezeCompileSourceMap,
    stripCompileSourceBoundaryMarkers,
    wrapCompileSourceBoundary,
} from '../services/compile_source_map';
import type {
    CompileSourceConfidence,
    CompileSourceMapV1,
    CompileSourceSection,
} from '../services/compile_source_map';
import { normalizePinCodeToken } from '../services/pin_code_token';

const NamesProto = (Blockly as any)?.Names?.prototype;
if (NamesProto && typeof NamesProto.getNameForUserVariable === 'function' && !NamesProto.__ckLegacyNameFallbackPatched) {
    const originalGetNameForUserVariable = NamesProto.getNameForUserVariable;
    NamesProto.getNameForUserVariable = function (id: string) {
        if (!this.variableMap) {
            // Keep legacy behavior for third-party generators that never set variable map.
            return String(id || '');
        }
        return originalGetNameForUserVariable.call(this, id);
    };
    NamesProto.__ckLegacyNameFallbackPatched = true;
}

const rawGenerator = new Blockly.Generator('Arduino');
// Many legacy extensions access generator.nameDB_ globally before init is called during workspaceToCode.
// Ensure it is instantiated immediately.
rawGenerator.nameDB_ = new Blockly.Names(rawGenerator.RESERVED_WORDS_);
const fallbackVariableMap = {
    // Keep legacy behavior when generators call getName(id, 'VARIABLE') without a workspace map.
    getVariableById(id: string) {
        return {
            getName: () => String(id || '')
        };
    }
};
rawGenerator.nameDB_.setVariableMap(fallbackVariableMap as any);

const ensureNameDbVariableMap = (generator: any, workspace?: any) => {
    if (!generator.nameDB_) {
        generator.nameDB_ = new Blockly.Names(generator.RESERVED_WORDS_);
    }
    const variableMap = workspace?.getVariableMap?.() || fallbackVariableMap;
    if (generator.__ckVariableMapRef !== variableMap) {
        generator.nameDB_.setVariableMap(variableMap as any);
        generator.__ckVariableMapRef = variableMap;
    }
};

// Proxy Handler for Legacy Compatibility
// Redirects arduinoGenerator['block_type'] = func  --> arduinoGenerator.forBlock['block_type'] = func
const generatorProxy = new Proxy(rawGenerator, {
    set: function (target, prop, value) {
        // 1. If it's a System Property/Method, pass through
        const systemProps = [
            'name_', 'nameDB', 'nameDB_', 'RESERVED_WORDS_', 'FUNCTION_NAME_PLACEHOLDER_',
            'init', 'finish', 'scrub_', 'scrubNakedValue', 'quote_',
            'workspaceToCode', 'blockToCode', 'valueToCode', 'statementToCode',
            'addLoopTrap', 'addInclude', 'addSetup', 'addDeclaration',
            'addVariable', 'addFunction', 'addMacro', 'createPinVar', 'createVar',
            'definitions_', 'includes_', 'setups_', 'variables_', 'functions_', 'macros_',
            'ORDER_ATOMIC', 'PRECEDENCE', 'INDENT'
        ];

        // Also check keywords typically present in Blockly Generators
        if (typeof prop === 'string' && (
            systemProps.includes(prop) ||
            prop.startsWith('ORDER_') ||
            prop.startsWith('TYPE_') ||
            prop.startsWith('create') ||
            prop.startsWith('get') ||
            prop.startsWith('add') ||
            prop.startsWith('math')
        )) {
            return Reflect.set(target, prop, value);
        }

        // 2. If it is a Function and NOT a system method, assume it is a Block Generator
        // Legacy: Blockly.Arduino['my_block'] = function(block) { ... }
        if (typeof value === 'function' && typeof prop === 'string') {
            console.log(`[ArduinoGen] Proxy: Redirecting legacy assignment for '${prop}' to forBlock`);
            target.forBlock[prop] = value;
            return true;
        }

        // 3. Default: Pass through (e.g. extra properties constants)
        return Reflect.set(target, prop, value);
    },
    get: function (target, prop) {
        if (prop === 'nameDB_') {
            if (!target.nameDB_) {
                target.nameDB_ = new Blockly.Names(target.RESERVED_WORDS_);
                target.nameDB_.setVariableMap(fallbackVariableMap as any);
            }
            return target.nameDB_;
        }
        if (prop === 'nameDB') {
            if (!target.nameDB_) {
                target.nameDB_ = new Blockly.Names(target.RESERVED_WORDS_);
                target.nameDB_.setVariableMap(fallbackVariableMap as any);
            }
            return target.nameDB_;
        }
        return Reflect.get(target, prop);
    }
});

export const arduinoGenerator = generatorProxy;
export default arduinoGenerator;

let generatorTargetFqbn = '';
let generatorTargetCoreVersion = '';

export const setArduinoGeneratorTarget = (fqbn: string, coreVersion = '') => {
    generatorTargetFqbn = String(fqbn || '').trim().toLowerCase();
    generatorTargetCoreVersion = String(coreVersion || '').trim();
};

export const getArduinoGeneratorTarget = () => ({
    fqbn: generatorTargetFqbn,
    coreVersion: generatorTargetCoreVersion,
});

const ensureWifiSupport = () => {
    const header = generatorTargetFqbn.startsWith('esp8266:esp8266:')
        ? '#include <ESP8266WiFi.h>'
        : '#include <WiFi.h>';
    arduinoGenerator.addInclude('wifi', header);
};

// --- Compile-session source map v1 + legacy line mapping compatibility ---
let _lineToBlockMap: Map<number, string> = new Map();
let _compileSourceMap: Readonly<CompileSourceMapV1> | null = null;
let _sourceBoundarySequence = 0;

const SOURCE_ARTIFACT_REGISTRIES = [
    'includes_',
    'definitions_',
    'variables_',
    'macros_',
    'functions_',
    'customGlobals_',
    'setups_',
    'customSetups_',
    'customLoops_',
] as const;

type SourceArtifactRegistry = typeof SOURCE_ARTIFACT_REGISTRIES[number];

interface GeneratedArtifactOrigin {
    blockId: string;
    blockType: string;
    value: string;
}

interface ExpressionEmission {
    code: string;
}

let _artifactOrigins = new Map<SourceArtifactRegistry, Map<string, GeneratedArtifactOrigin>>();
let _activeGenerationBlocks: any[] = [];
let _expressionEmissions = new Map<string, ExpressionEmission[]>();

const resetSourceMapGenerationState = () => {
    _lineToBlockMap = new Map();
    _compileSourceMap = null;
    _sourceBoundarySequence = 0;
    _activeGenerationBlocks = [];
    _expressionEmissions = new Map();
    _artifactOrigins = new Map(
        SOURCE_ARTIFACT_REGISTRIES.map(name => [name, new Map()]),
    );
};

resetSourceMapGenerationState();

const nextSourceBoundaryId = (prefix: string): string => {
    _sourceBoundarySequence += 1;
    return `${prefix}${_sourceBoundarySequence.toString(36)}`;
};

const sourceBlockMetadata = (block: any): { blockId: string; blockType: string } | null => {
    const blockId = String(block?.id || '');
    if (!blockId) return null;
    return {
        blockId,
        blockType: String(block?.type || 'unknown'),
    };
};

const GLOBAL_DEFS_CONTAINER_BLOCK_TYPES = new Set([
    'controls_global_defs_custom',
]);

const SETUP_CONTAINER_BLOCK_TYPES = new Set([
    'controls_setup_custom',
    'arduino_setup',
    'base_setup',
]);

const LOOP_CONTAINER_BLOCK_TYPES = new Set([
    'controls_loop_custom',
    'arduino_loop',
    'base_loop',
]);

export const STRUCTURED_ROOT_BLOCK_TYPES = new Set([
    ...GLOBAL_DEFS_CONTAINER_BLOCK_TYPES,
    ...SETUP_CONTAINER_BLOCK_TYPES,
    ...LOOP_CONTAINER_BLOCK_TYPES,
]);

const DEFINITION_CONTAINER_BLOCK_TYPES = new Set([
    'controls_global_defs_custom',
    'procedures_defnoreturn',
    'procedures_defreturn',
]);

/**
 * Mind+-style active root predicate: when a workspace uses structured roots
 * (Definitions / Setup / Loop), only those containers, function definitions,
 * and true hat blocks (no previous or output connection) participate in code
 * generation. Loose detached blocks parked on the blank canvas stay inactive.
 */
export const isActiveStructuredTopBlock = (block: any): boolean => {
    if (!block) return false;
    const type = String(block.type || '');
    if (STRUCTURED_ROOT_BLOCK_TYPES.has(type) || DEFINITION_CONTAINER_BLOCK_TYPES.has(type)) {
        return true;
    }
    return !block.previousConnection && !block.outputConnection;
};

export const hasStructuredWorkspaceRoots = (workspace: Blockly.Workspace | null | undefined): boolean => {
    if (!workspace || typeof workspace.getTopBlocks !== 'function') return false;
    return workspace.getTopBlocks(false).some((block: any) => (
        STRUCTURED_ROOT_BLOCK_TYPES.has(String(block?.type || ''))
    ));
};

/** Resolve the section from Blockly's structural parentage, not generation order.
 * `scrub_` generates a block's `next` sibling before returning, so the active
 * generator stack alone would incorrectly classify a top-level block following
 * a setup/procedure container as part of that container.
 */
const sourceSectionForStatement = (block: any): CompileSourceSection => {
    let cursor = block;
    const visited = new Set<any>();
    while (cursor && !visited.has(cursor)) {
        visited.add(cursor);
        const type = String(cursor?.type || '');
        if (SETUP_CONTAINER_BLOCK_TYPES.has(type)) return 'setup';
        if (DEFINITION_CONTAINER_BLOCK_TYPES.has(type)) return 'definition';
        cursor = typeof cursor?.getSurroundParent === 'function'
            ? cursor.getSurroundParent()
            : null;
    }
    return 'loop';
};

const wrapGeneratedFragment = (
    code: string,
    source: { blockId: string; blockType: string } | null | undefined,
    section: CompileSourceSection,
    confidence: CompileSourceConfidence,
    prefix: string,
): string => {
    if (!source || !String(code || '').trim()) return String(code || '');
    return wrapCompileSourceBoundary(String(code), {
        boundaryId: nextSourceBoundaryId(prefix),
        blockId: source.blockId,
        blockType: source.blockType,
        section,
        confidence,
    });
};

const artifactEntries = (registry: unknown): Array<[string, string]> => {
    if (Array.isArray(registry)) {
        return registry.map((value, index) => [String(index), String(value ?? '')]);
    }
    if (!registry || typeof registry !== 'object') return [];
    return Object.keys(registry as Record<string, unknown>)
        .map(key => [key, String((registry as Record<string, unknown>)[key] ?? '')]);
};

type SourceArtifactSnapshot = Map<SourceArtifactRegistry, Map<string, string>>;

const snapshotSourceArtifacts = (): SourceArtifactSnapshot => new Map(
    SOURCE_ARTIFACT_REGISTRIES.map(name => [
        name,
        new Map(artifactEntries((arduinoGenerator as any)[name])),
    ]),
);

const captureSourceArtifactOrigins = (
    block: any,
    before: SourceArtifactSnapshot,
) => {
    const source = sourceBlockMetadata(block);
    if (!source) return;
    const after = snapshotSourceArtifacts();

    for (const registryName of SOURCE_ARTIFACT_REGISTRIES) {
        const beforeEntries = before.get(registryName) || new Map<string, string>();
        const origins = _artifactOrigins.get(registryName) || new Map<string, GeneratedArtifactOrigin>();
        _artifactOrigins.set(registryName, origins);
        for (const [key, value] of after.get(registryName) || []) {
            if (beforeEntries.get(key) === value) continue;
            const existing = origins.get(key);
            // A nested block already attributed this exact final value. The outer
            // block observes the same mutation but must not steal its provenance.
            if (existing?.value === value) continue;
            origins.set(key, { ...source, value });
        }
    }
};

const artifactOriginFor = (
    registryName: SourceArtifactRegistry,
    key: string,
    finalValue: unknown,
): GeneratedArtifactOrigin | null => {
    const origin = _artifactOrigins.get(registryName)?.get(String(key)) || null;
    return origin && origin.value === String(finalValue ?? '') ? origin : null;
};

const generatedSourceEntries = (
    registryName: SourceArtifactRegistry,
    registry: unknown,
): GeneratedSourceEntry[] => {
    const entries = artifactEntries(registry);
    if (!Array.isArray(registry)) {
        entries.sort(([left], [right]) => left.localeCompare(right, 'en'));
    }
    return entries.map(([tag, code]) => ({
        tag,
        code,
        origin: artifactOriginFor(registryName, tag, code),
    }));
};

const recordExpressionEmission = (ownerBlock: any, generated: unknown) => {
    const owner = sourceBlockMetadata(ownerBlock);
    if (!owner || !Array.isArray(generated) || typeof generated[0] !== 'string') return;
    const code = String(generated[0] || '');
    if (!code.trim()) return;
    const existing = _expressionEmissions.get(owner.blockId) || [];
    existing.push({ code });
    _expressionEmissions.set(owner.blockId, existing);
};

const wrapLineRange = (
    code: string,
    lineStart: number,
    lineEnd: number,
    source: { blockId: string; blockType: string },
): string => {
    const lines = String(code || '').split('\n');
    const startIndex = Math.max(0, lineStart - 1);
    const endIndex = Math.min(lines.length - 1, lineEnd - 1);
    if (startIndex > endIndex) return code;
    const wrapped = wrapGeneratedFragment(
        lines.slice(startIndex, endIndex + 1).join('\n'),
        source,
        'expression',
        'medium',
        'e',
    ).split('\n');
    lines.splice(startIndex, endIndex - startIndex + 1, ...wrapped);
    return lines.join('\n');
};

/** Map nested value-code failures back to their owning statement block. */
const addExpressionParentBoundaries = (block: any, code: string): string => {
    const source = sourceBlockMetadata(block);
    if (!source) return code;
    const emissions = _expressionEmissions.get(source.blockId) || [];
    _expressionEmissions.delete(source.blockId);
    if (emissions.length === 0) return code;

    const original = String(code || '');
    const ranges = new Map<string, { lineStart: number; lineEnd: number }>();
    for (const emission of emissions) {
        const offset = original.indexOf(emission.code);
        if (offset < 0) continue;
        const lineStart = original.slice(0, offset).split('\n').length;
        const lineEnd = lineStart + emission.code.split('\n').length - 1;
        ranges.set(`${lineStart}:${lineEnd}`, { lineStart, lineEnd });
    }

    let mapped = original;
    for (const range of Array.from(ranges.values()).sort((left, right) => (
        (right.lineEnd - right.lineStart) - (left.lineEnd - left.lineStart)
        || left.lineStart - right.lineStart
    ))) {
        mapped = wrapLineRange(mapped, range.lineStart, range.lineEnd, source);
    }
    return mapped;
};

/** Given a 1-indexed line number in the generated code, return the Blockly block ID. */
export function getBlockIdForLine(line: number): string | null {
    return _lineToBlockMap.get(line) || null;
}

/** Return the complete mapping (for scanning multiple errors). */
export function getLineToBlockMap(): ReadonlyMap<number, string> {
    return _lineToBlockMap;
}

/** The immutable map for the most recently generated compile sketch. */
export function getCompileSourceMap(): Readonly<CompileSourceMapV1> | null {
    return _compileSourceMap;
}

/** Internal: freeze the exact final sketch and derive the old line map from it. */
function _freezeGeneratedSourceMap(code: string): string {
    _compileSourceMap = freezeCompileSourceMap(code, { file: 'sketch.ino' });
    _lineToBlockMap = new Map(compileSourceMapToLegacyLineMap(_compileSourceMap));
    // Markers stay in compiler input as valid C++ comments. Preview stripping is
    // presentation-only and therefore cannot invalidate the frozen code hash.
    return code;
}

/** Strip @ck markers from code for clean display in the code preview panel. */
export function stripBlockMarkers(code: string): string {
    return stripCompileSourceBoundaryMarkers(stripBlockMarkerComments(code));
}

// Order of operations (simplified for C++)
const Order = {
    ATOMIC: 0,
    NONE: 99,
};
// @ts-ignore
arduinoGenerator.ORDER_ATOMIC = Order.ATOMIC;
// Backward-compatible alias for third-party/custom generators using legacy Blockly constants.
// @ts-ignore
arduinoGenerator.ORDER_NONE = Order.NONE;
// @ts-ignore — many third-party extensions (BH1750, etc.) reference ORDER_FUNCTION_CALL
arduinoGenerator.ORDER_FUNCTION_CALL = 2;
// @ts-ignore
arduinoGenerator.ORDER_MEMBER = 1;
// @ts-ignore
arduinoGenerator.ORDER_UNARY_POSTFIX = 1;
// @ts-ignore
arduinoGenerator.ORDER_ADDITION = 6;
// @ts-ignore
arduinoGenerator.ORDER_MULTIPLICATION = 5;

// Shim methods for third-party extensions (like Mixly/Mind+ style code generators)
['variables_', 'functions_', 'macros_', 'setups_', 'includes_'].forEach(key => {
    // @ts-ignore
    arduinoGenerator[key] = arduinoGenerator[key] || {};
});

// @ts-ignore
arduinoGenerator.addVariable = function (name: string, code: string) {
    this.variables_ = this.variables_ || {};
    this.variables_[name] = code;
};
// @ts-ignore
arduinoGenerator.addFunction = function (name: string, code: string) {
    this.functions_ = this.functions_ || {};
    this.functions_[name] = code;
};
// @ts-ignore
arduinoGenerator.addMacro = function (name: string, code: string) {
    this.macros_ = this.macros_ || {};
    this.macros_[name] = code;
};
// @ts-ignore
arduinoGenerator.addInclude = function (name: string, code: string) {
    this.includes_ = this.includes_ || {};
    if (Object.values(this.includes_).includes(code)) return;
    this.includes_[name] = code;
};
// @ts-ignore
arduinoGenerator.addDeclaration = function (name: string, code: string) {
    this.variables_ = this.variables_ || {};
    // Different declarative block types may share one device instance. Their
    // runtime keys are intentionally namespaced by block type, so key-only
    // dedupe is insufficient and can emit the exact same C++ declaration
    // twice. Identical source is always redundant and often a hard compile
    // error; keep the first declaration without weakening name isolation.
    if (Object.values(this.variables_).includes(code)) return;
    this.variables_[name] = code;
};
// @ts-ignore
arduinoGenerator.addSetup = function (name: string, code: string) {
    this.setups_ = this.setups_ || {};
    if (Object.values(this.setups_).includes(code)) return;
    this.setups_[name] = code;
};

// Hook into init to set up nameDB_ for legacy extensions.
const ensureNameDbOnInit = (generator: any, workspace?: any) => {
    if (!generator.nameDB_) {
        generator.nameDB_ = new Blockly.Names(generator.RESERVED_WORDS_);
    } else {
        generator.nameDB_.reset();
    }
    ensureNameDbVariableMap(generator, workspace);
};

// Some legacy flows call blockToCode/workspaceToCode directly without a prior init(workspace).
// Ensure nameDB_ always has a variable map before code generation.
// @ts-ignore
const originalWorkspaceToCode = arduinoGenerator.workspaceToCode;
// @ts-ignore
arduinoGenerator.workspaceToCode = function (workspace: Blockly.Workspace) {
    ensureNameDbVariableMap(this, workspace);
    if (!hasStructuredWorkspaceRoots(workspace)) {
        return originalWorkspaceToCode.call(this, workspace);
    }
    const code: string[] = [];
    this.init(workspace);
    const blocks = workspace.getTopBlocks(true);
    for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        if (!isActiveStructuredTopBlock(block)) continue;
        let line = this.blockToCode(block);
        if (Array.isArray(line)) {
            line = line[0];
        }
        if (line) {
            if ((block as any).outputConnection) {
                line = this.scrubNakedValue(line);
            }
            code.push(line);
        }
    }
    let finalCode = code.join('\n');
    finalCode = this.finish(finalCode);
    finalCode = finalCode.replace(/^\s+\n/, '');
    finalCode = finalCode.replace(/\n\s+$/, '\n');
    finalCode = finalCode.replace(/[ \t]+\n/g, '\n');
    return finalCode;
};

// @ts-ignore
const originalBlockToCode = arduinoGenerator.blockToCode;
// @ts-ignore
arduinoGenerator.blockToCode = function (block: any, ...rest: any[]) {
    ensureNameDbVariableMap(this, block?.workspace);
    const artifactSnapshot = snapshotSourceArtifacts();
    const expressionOwner = [..._activeGenerationBlocks]
        .reverse()
        .find(candidate => !candidate?.outputConnection);
    _activeGenerationBlocks.push(block);
    let generated: unknown;
    try {
        generated = originalBlockToCode.call(this, block, ...rest);
        return generated;
    } finally {
        captureSourceArtifactOrigins(block, artifactSnapshot);
        if (block?.outputConnection && expressionOwner) {
            recordExpressionEmission(expressionOwner, generated);
        }
        _activeGenerationBlocks.pop();
    }
};

// @ts-ignore
arduinoGenerator.createPinVar = function (_workspace: any, pin: string) {
    // Simply returns the pin directly, satisfying extensions that expect this undocumented Mixly API
    return pin;
};

const sanitizeIdentifier = (id: string): string => {
    return String(id || '')
        .replace(/[^a-zA-Z0-9_]/g, '_')
        .replace(/^(\d)/, '_$1')
        .slice(0, 48) || 'id';
};

const escapeRegExp = (s: string): string => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const sanitizeVariableName = (name: string): string => {
    const sid = sanitizeIdentifier(name || 'variable');
    return sid === 'id' ? 'variable' : sid;
};

const resolveVariableFieldName = (block: any, fieldName: string, fallback: string): string => {
    try {
        const field = block?.getField?.(fieldName);
        const text = typeof field?.getText === 'function' ? String(field.getText() || '').trim() : '';
        if (text) return text;

        const rawValue = block?.getFieldValue?.(fieldName);
        if (typeof rawValue === 'string' && rawValue.trim()) {
            const ws = block?.workspace;
            const fromMap = ws?.getVariableMap?.()?.getVariableById?.(rawValue);
            if (fromMap?.name) return String(fromMap.name);
            return rawValue;
        }
    } catch {
        // Ignore and fall back.
    }
    return fallback;
};

const resolveLValueFromInputOrField = (
    block: any,
    inputName: string,
    fieldName: string,
    fallback: string
): string => {
    const inputCode = String(arduinoGenerator.valueToCode(block, inputName, Order.NONE) || '').trim();
    if (inputCode) {
        return inputCode;
    }
    const rawName = resolveVariableFieldName(block, fieldName, fallback);
    return sanitizeVariableName(rawName);
};

const definitionLines = (): string[] => {
    // @ts-ignore
    const defs = arduinoGenerator.definitions_ || {};
    return Object.keys(defs).map((k) => String(defs[k] ?? ''));
};

const hasDeclaredSymbol = (symbol: string): boolean => {
    const sid = sanitizeVariableName(symbol);
    const re = new RegExp(`\\b${escapeRegExp(sid)}\\b`);
    return definitionLines().some((line) => re.test(line));
};

const hasDeclared1dArray = (name: string): boolean => {
    const sid = sanitizeVariableName(name);
    const re = new RegExp(`\\b${escapeRegExp(sid)}\\s*\\[`);
    return definitionLines().some((line) => re.test(line));
};

const hasDeclared2dArray = (name: string): boolean => {
    const sid = sanitizeVariableName(name);
    const re = new RegExp(`\\b${escapeRegExp(sid)}\\s*\\[[^\\]]+\\]\\s*\\[`);
    return definitionLines().some((line) => re.test(line));
};

const ensureArray1dRuntimeContext = (name: string, lenVar: string): void => {
    const arrName = sanitizeVariableName(name);
    const lenName = sanitizeVariableName(lenVar);
    if (!hasDeclared1dArray(arrName)) {
        arduinoGenerator.addDeclaration(`arr1d_${arrName}`, `int ${arrName}[16] = {0};`);
    }
    if (!hasDeclaredSymbol(lenName)) {
        arduinoGenerator.addDeclaration(`arr1d_len_${lenName}`, `int ${lenName} = 0;`);
    }
};

const ensureArray2dRuntimeContext = (name: string, rowsVar: string): void => {
    const arrName = sanitizeVariableName(name);
    const rowsName = sanitizeVariableName(rowsVar);
    if (!hasDeclared2dArray(arrName)) {
        arduinoGenerator.addDeclaration(`arr2d_${arrName}`, `int ${arrName}[8][8] = {0};`);
    }
    if (!hasDeclaredSymbol(rowsName)) {
        arduinoGenerator.addDeclaration(`arr2d_rows_${rowsName}`, `int ${rowsName} = 0;`);
    }
};

const qualifierPrefix = (qual: string): string => {
    switch (qual) {
        case 'STATIC':
            return 'static ';
        case 'CONST':
            return 'const ';
        case 'VOLATILE':
            return 'volatile ';
        case 'STATIC_CONST':
            return 'static const ';
        case 'STATIC_VOLATILE':
            return 'static volatile ';
        default:
            return '';
    }
};

const defaultValueForType = (typeName: string): string => {
    switch (typeName) {
        case 'float':
        case 'double':
            return '0.0';
        case 'bool':
            return 'false';
        case 'char':
            return `'\\0'`;
        case 'String':
            return '""';
        default:
            return '0';
    }
};

const normalizeInitializerByType = (typeName: string, initValue: string): string => {
    const raw = (initValue || '').trim();
    if (!raw) return '';
    if (typeName === 'String') {
        // Toolbox numeric shadow often yields "0"; for String this should be empty string.
        if (raw === '0') return '""';
        return raw;
    }
    if (typeName === 'char' && raw === '0') {
        return `'\\0'`;
    }
    return raw;
};

const normalizeArrayValueByType = (typeName: string, valueCode: string): string => {
    const raw = (valueCode || '').trim();
    if (!raw) return defaultValueForType(typeName);
    if (typeName === 'String') {
        if (/^String\s*\(/.test(raw)) return raw;
        if (/^".*"$/.test(raw)) return raw;
        if (raw === '0') return '""';
        return `String(${raw})`;
    }
    if (typeName === 'char') {
        if (/^'.*'$/.test(raw)) return raw;
        if (/^".*"$/.test(raw)) {
            // Use first char of string literal.
            return `((${raw}).charAt(0))`;
        }
        if (raw === '0') return `'\\0'`;
    }
    if (typeName === 'bool') {
        if (raw === 'true' || raw === 'false') return raw;
        return `((${raw}) != 0)`;
    }
    return raw;
};

const normalizeProcedureReturnType = (typeName: string): string => {
    switch (String(typeName || '').trim()) {
        case 'int':
        case 'long':
        case 'float':
        case 'double':
        case 'bool':
        case 'String':
        case 'char':
        case 'byte':
        case 'unsigned int':
        case 'unsigned long':
        case 'int8_t':
        case 'uint8_t':
        case 'int16_t':
        case 'uint16_t':
        case 'int32_t':
        case 'uint32_t':
            return String(typeName);
        default:
            return 'int';
    }
};

const castProcedureReturnValue = (typeName: string, valueCode: string): string => {
    const value = String(valueCode || '').trim() || defaultValueForType(typeName);
    switch (typeName) {
        case 'String':
            if (value === '""') return 'String("")';
            if (/^String\s*\(/.test(value)) return value;
            if (/^".*"$/.test(value)) return `String(${value})`;
            return `String(${value})`;
        case 'bool':
            if (value === 'true' || value === 'false') return value;
            return `((${value}) ? true : false)`;
        case 'char':
            if (/^'.*'$/.test(value)) return value;
            return `((char)(${value}))`;
        case 'byte':
            return `((byte)(${value}))`;
        case 'int8_t':
        case 'uint8_t':
        case 'int16_t':
        case 'uint16_t':
        case 'int32_t':
        case 'uint32_t':
        case 'int':
        case 'long':
        case 'float':
        case 'double':
        case 'unsigned int':
        case 'unsigned long':
            return `((${typeName})(${value}))`;
        default:
            return value;
    }
};

const getProcedureArgNames = (block: any): string[] => {
    let rawArgs: any[] = [];
    // Legacy procedure defs keep readable parameter names in arguments_.
    if (Array.isArray(block?.arguments_)) {
        rawArgs = block.arguments_;
    } else if (typeof block?.getVars === 'function') {
        const vars = block.getVars();
        if (Array.isArray(vars)) rawArgs = vars;
    }
    const used = new Set<string>();
    return rawArgs.map((arg, idx) => {
        const base = sanitizeVariableName(String(arg || `arg${idx + 1}`));
        let name = base || `arg${idx + 1}`;
        let n = 1;
        while (used.has(name)) {
            n++;
            name = `${base}_${n}`;
        }
        used.add(name);
        return name;
    });
};

const inferEnclosingProcedureReturnType = (block: any): string => {
    let cursor = block;
    while (cursor) {
        if (cursor.type === 'procedures_defreturn') {
            return normalizeProcedureReturnType(cursor.getFieldValue?.('RET_TYPE') || 'int');
        }
        if (cursor.type === 'procedures_defnoreturn') {
            return 'void';
        }
        cursor = typeof cursor.getSurroundParent === 'function' ? cursor.getSurroundParent() : null;
    }
    return 'auto';
};

const collectRowLiteralValues = (rowBlock: any): string[] => {
    const itemCount = Math.max(0, Number(rowBlock?.itemCount_ || 0));
    const values: string[] = [];
    for (let i = 0; i < itemCount; i++) {
        const value = (arduinoGenerator.valueToCode(rowBlock, `VALUE${i}`, Order.ATOMIC) || '0').trim();
        values.push(value || '0');
    }
    return values;
};

const pinFromInputOrField = (block: any, name: string, fallback: string): string => {
    const fromInput = arduinoGenerator.valueToCode(block, name, Order.ATOMIC);
    if (fromInput) return fromInput;
    const fromField = block.getFieldValue(name);
    return fromField || fallback;
};

/** Track pins whose mode was explicitly set by the user via a set_pin_mode / io_pinmode block. */
const _userExplicitPinModes = new Set<string>();

const ensurePinOutputSetup = (pinExpr: string, _hint: string): void => {
    const pinKey = String(pinExpr).trim();
    // If the user already placed an explicit pinMode block for this pin, respect it.
    if (_userExplicitPinModes.has(pinKey)) return;
    // @ts-ignore
    const setups = arduinoGenerator.setups_ || {};
    // Check if any existing setup already configures this pin.
    const canonicalKey = `pinmode_pin_${sanitizeIdentifier(pinKey)}`;
    if (setups[canonicalKey]) return;
    arduinoGenerator.addSetup(canonicalKey, `pinMode(${pinExpr}, OUTPUT);`);
};

const ensureSerialSetup = (baudExpr = '115200'): void => {
    // @ts-ignore
    if (!arduinoGenerator.setups_['serial']) {
        // @ts-ignore
        arduinoGenerator.setups_['serial'] = `Serial.begin(${baudExpr});`;
    }
};

const ensureMathHeader = (): void => {
    arduinoGenerator.addInclude('math', '#include <math.h>');
};

const charLiteralFromField = (value: string | null | undefined): string => {
    const raw = String(value ?? '').trim();
    if (!raw) return `'\\n'`;
    if (raw === '\\n') return `'\\n'`;
    if (raw === '\\r') return `'\\r'`;
    if (raw === '\\t') return `'\\t'`;
    const ch = raw[0];
    if (ch === '\\') return `'\\\\'`;
    if (ch === '\'') return `'\\''`;
    return `'${ch}'`;
};

const escapeCppString = (value: string | null | undefined): string => {
    return String(value ?? '')
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"');
};

const ensureTextToBoolHelper = (): void => {
    arduinoGenerator.addDeclaration('ck_text_to_bool', `bool ck_text_to_bool(String s) {
  s.trim();
  s.toLowerCase();
  if (s == "1" || s == "true" || s == "yes" || s == "on") return true;
  if (s == "0" || s == "false" || s == "no" || s == "off") return false;
  return s.toInt() != 0;
}`);
};

const ensureTextSubstringHelper = (): void => {
    arduinoGenerator.addDeclaration('ck_text_substr_1_based', `String ck_text_substr_1_based(String s, int startPos, int endPos) {
  int len = s.length();
  int start = startPos - 1;
  if (start < 0) start = 0;
  if (start > len) start = len;
  int endExclusive = endPos;
  if (endExclusive < start) endExclusive = start;
  if (endExclusive > len) endExclusive = len;
  return s.substring(start, endExclusive);
}`);
};

const ensureTextCaseHelper = (): void => {
    arduinoGenerator.addDeclaration('ck_text_case_convert', `String ck_text_case_convert(String s, bool upper) {
  if (upper) s.toUpperCase();
  else s.toLowerCase();
  return s;
}`);
};

const ensureTextTrimHelper = (): void => {
    arduinoGenerator.addDeclaration('ck_text_trim_mode', `String ck_text_trim_mode(String s, int mode) {
  int start = 0;
  int end = s.length() - 1;
  if (mode == 0 || mode == 1) {
    while (start <= end && (unsigned char)s.charAt(start) <= 32) start++;
  }
  if (mode == 0 || mode == 2) {
    while (end >= start && (unsigned char)s.charAt(end) <= 32) end--;
  }
  if (start > end) return "";
  return s.substring(start, end + 1);
}`);
};

const ensureTextCountHelper = (): void => {
    arduinoGenerator.addDeclaration('ck_text_count_occurrence', `int ck_text_count_occurrence(String haystack, String needle) {
  if (needle.length() == 0) return 0;
  int count = 0;
  int idx = 0;
  while (true) {
    idx = haystack.indexOf(needle, idx);
    if (idx < 0) break;
    count++;
    idx += needle.length();
  }
  return count;
}`);
};

const ensureTextReplaceAllHelper = (): void => {
    arduinoGenerator.addDeclaration('ck_text_replace_all', `String ck_text_replace_all(String src, String from, String to) {
  if (from.length() == 0) return src;
  int idx = 0;
  while (true) {
    idx = src.indexOf(from, idx);
    if (idx < 0) break;
    src = src.substring(0, idx) + to + src.substring(idx + from.length());
    idx += to.length();
  }
  return src;
}`);
};

const ensureTextReverseHelper = (): void => {
    arduinoGenerator.addDeclaration('ck_text_reverse', `String ck_text_reverse(String s) {
  int len = s.length();
  String out = "";
  out.reserve(len);
  for (int i = len - 1; i >= 0; --i) {
    out += s.charAt(i);
  }
  return out;
}`);
};

const ensureArrayCrudHelpers = (): void => {
    arduinoGenerator.addDeclaration('ck_array_crud_helpers', `template<typename T, size_t N>
bool ck_array_push(T (&arr)[N], int& len, const T& value) {
  if (len < 0) len = 0;
  if (len >= (int)N) return false;
  arr[len++] = value;
  return true;
}

template<typename T, size_t N>
bool ck_array_insert(T (&arr)[N], int& len, int index, const T& value) {
  if (len < 0) len = 0;
  if (len >= (int)N) return false;
  if (index < 0) index = 0;
  if (index > len) index = len;
  for (int i = len; i > index; --i) {
    arr[i] = arr[i - 1];
  }
  arr[index] = value;
  len++;
  return true;
}

template<typename T, size_t N>
bool ck_array_remove(T (&arr)[N], int& len, int index) {
  if (len <= 0) {
    len = 0;
    return false;
  }
  if (index < 0 || index >= len) return false;
  for (int i = index; i < len - 1; ++i) {
    arr[i] = arr[i + 1];
  }
  len--;
  return true;
}

template<typename T, size_t N>
int ck_array_find(const T (&arr)[N], int len, const T& value) {
  if (len < 0) len = 0;
  if (len > (int)N) len = (int)N;
  for (int i = 0; i < len; ++i) {
    if (arr[i] == value) return i;
  }
  return -1;
}`);
};

const ensureArrayAlgoHelpers = (): void => {
    arduinoGenerator.addDeclaration('ck_array_algo_helpers', `template<typename T, size_t N>
void ck_array_quick_sort_impl(T (&arr)[N], int left, int right, bool desc) {
  int i = left;
  int j = right;
  T pivot = arr[left + ((right - left) / 2)];
  while (i <= j) {
    if (!desc) {
      while (arr[i] < pivot) i++;
      while (arr[j] > pivot) j--;
    } else {
      while (arr[i] > pivot) i++;
      while (arr[j] < pivot) j--;
    }
    if (i <= j) {
      T tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
      i++;
      j--;
    }
  }
  if (left < j) ck_array_quick_sort_impl(arr, left, j, desc);
  if (i < right) ck_array_quick_sort_impl(arr, i, right, desc);
}

template<typename T, size_t N>
void ck_array_sort(T (&arr)[N], int len, bool desc) {
  if (len < 0) len = 0;
  if (len > (int)N) len = (int)N;
  if (len <= 1) return;
  ck_array_quick_sort_impl(arr, 0, len - 1, desc);
}

template<typename T, size_t N>
void ck_array_reverse(T (&arr)[N], int len) {
  if (len < 0) len = 0;
  if (len > (int)N) len = (int)N;
  for (int i = 0, j = len - 1; i < j; ++i, --j) {
    T tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
}

template<typename T, size_t N>
void ck_array_fill(T (&arr)[N], int len, const T& value) {
  if (len < 0) len = 0;
  if (len > (int)N) len = (int)N;
  for (int i = 0; i < len; ++i) {
    arr[i] = value;
  }
}

template<typename T, size_t D, size_t S>
int ck_array_copy(T (&dst)[D], const T (&src)[S], int srcLen) {
  if (srcLen < 0) srcLen = 0;
  if (srcLen > (int)S) srcLen = (int)S;
  int n = srcLen;
  if (n > (int)D) n = (int)D;
  for (int i = 0; i < n; ++i) {
    dst[i] = src[i];
  }
  return n;
}

template<typename T, size_t N>
void ck_array_rotate(T (&arr)[N], int len, int step, bool right) {
  if (len < 0) len = 0;
  if (len > (int)N) len = (int)N;
  if (len <= 1) return;
  int k = step % len;
  if (k < 0) k += len;
  if (k == 0) return;
  if (!right) {
    for (int s = 0; s < k; ++s) {
      T first = arr[0];
      for (int i = 0; i < len - 1; ++i) arr[i] = arr[i + 1];
      arr[len - 1] = first;
    }
  } else {
    for (int s = 0; s < k; ++s) {
      T last = arr[len - 1];
      for (int i = len - 1; i > 0; --i) arr[i] = arr[i - 1];
      arr[0] = last;
    }
  }
}`);
};

const ensureArray2dCrudHelpers = (): void => {
    arduinoGenerator.addDeclaration('ck_array2d_crud_helpers', `template<typename T, size_t R, size_t C>
bool ck_array2d_push_row_fill(T (&arr)[R][C], int& rows, const T& value) {
  if (rows < 0) rows = 0;
  if (rows >= (int)R) return false;
  for (size_t c = 0; c < C; ++c) {
    arr[rows][c] = value;
  }
  rows++;
  return true;
}

template<typename T, size_t R, size_t C>
bool ck_array2d_insert_row_fill(T (&arr)[R][C], int& rows, int rowIndex, const T& value) {
  if (rows < 0) rows = 0;
  if (rows >= (int)R) return false;
  if (rowIndex < 0) rowIndex = 0;
  if (rowIndex > rows) rowIndex = rows;
  for (int r = rows; r > rowIndex; --r) {
    for (size_t c = 0; c < C; ++c) {
      arr[r][c] = arr[r - 1][c];
    }
  }
  for (size_t c = 0; c < C; ++c) {
    arr[rowIndex][c] = value;
  }
  rows++;
  return true;
}

template<typename T, size_t R, size_t C>
bool ck_array2d_remove_row(T (&arr)[R][C], int& rows, int rowIndex) {
  if (rows <= 0) {
    rows = 0;
    return false;
  }
  if (rowIndex < 0 || rowIndex >= rows) return false;
  for (int r = rowIndex; r < rows - 1; ++r) {
    for (size_t c = 0; c < C; ++c) {
      arr[r][c] = arr[r + 1][c];
    }
  }
  rows--;
  return true;
}

template<typename T, size_t R, size_t C>
bool ck_array2d_contains(const T (&arr)[R][C], int rows, const T& value) {
  if (rows < 0) rows = 0;
  if (rows > (int)R) rows = (int)R;
  for (int r = 0; r < rows; ++r) {
    for (size_t c = 0; c < C; ++c) {
      if (arr[r][c] == value) return true;
    }
  }
  return false;
}

template<typename T, size_t R, size_t C>
int ck_array2d_find_linear(const T (&arr)[R][C], int rows, const T& value) {
  if (rows < 0) rows = 0;
  if (rows > (int)R) rows = (int)R;
  for (int r = 0; r < rows; ++r) {
    for (size_t c = 0; c < C; ++c) {
      if (arr[r][c] == value) return (r * (int)C + (int)c);
    }
  }
  return -1;
}`);
};

const ensureMsTimer2Support = () => {
    arduinoGenerator.addInclude('ck_mstimer2_support', `#if defined(ARDUINO_ARCH_AVR)
#include <MsTimer2.h>
#define CK_MSTIMER2_RUN() ((void)0)
#else
class CKMsTimer2Compat {
public:
  typedef void (*Callback)();
  void set(unsigned long intervalMs, Callback cb) {
    intervalMs_ = intervalMs;
    callback_ = cb;
    lastTick_ = millis();
  }
  void start() {
    running_ = true;
    lastTick_ = millis();
  }
  void stop() { running_ = false; }
  void run() {
    if (!running_ || callback_ == nullptr || intervalMs_ == 0) return;
    unsigned long now = millis();
    if ((now - lastTick_) >= intervalMs_) {
      lastTick_ += intervalMs_;
      callback_();
    }
  }
private:
  unsigned long intervalMs_ = 0;
  unsigned long lastTick_ = 0;
  bool running_ = false;
  Callback callback_ = nullptr;
};
static CKMsTimer2Compat ck_ms_timer2;
namespace MsTimer2 {
inline void set(unsigned long ms, CKMsTimer2Compat::Callback cb) { ck_ms_timer2.set(ms, cb); }
inline void start() { ck_ms_timer2.start(); }
inline void stop() { ck_ms_timer2.stop(); }
}
#define CK_MSTIMER2_RUN() ck_ms_timer2.run()
#endif`);

    // @ts-ignore
    if (!arduinoGenerator.__ckMsTimer2LoopHookAdded) {
        // @ts-ignore
        arduinoGenerator.customLoops_.push('  CK_MSTIMER2_RUN();');
        // @ts-ignore
        arduinoGenerator.__ckMsTimer2LoopHookAdded = true;
    }
};

/**
 * Lightweight C++ Formatter (Auto-Indentation)
 * O(N) performance, no external deps.
 */
function formatCpp(code: string): string {
    const lines = code.split('\n');
    let indentLevel = 0;
    const indentStr = '  '; // 2 spaces
    const formatted: string[] = [];

    for (let line of lines) {
        line = line.trim();
        if (!line) {
            formatted.push('');
            continue;
        }

        // Preprocessor directives always stay at column 0.
        if (line.startsWith('#')) {
            formatted.push(line);
            continue;
        }

        const codeOnly = line.replace(/\\./g, '').replace(/"[^"]*"/g, '').replace(/'[^']*'/g, '').replace(/\/\/.*$/, '').replace(/\/\*[\s\S]*?\*\//g, '');
        
        // Dedent closing braces / access specifiers.
        if (codeOnly.startsWith('}') || line.startsWith('private:') || line.startsWith('public:') || line.startsWith('protected:')) {
            indentLevel = Math.max(0, indentLevel - 1);
        }

        formatted.push(indentStr.repeat(indentLevel) + line);

        // Adjust indent level based on brace balance.
        const openCount = (codeOnly.match(/\{/g) || []).length;
        const closeCount = (codeOnly.match(/\}/g) || []).length;
        const net = openCount - closeCount;
        if (codeOnly.startsWith('}') || line.startsWith('private:') || line.startsWith('public:') || line.startsWith('protected:')) {
            // We already decremented once for the leading '}'. Compensate by +1.
            indentLevel = Math.max(0, indentLevel + net + 1);
        } else {
            indentLevel = Math.max(0, indentLevel + net);
        }
    }

    // Collapse runs of >2 consecutive blank lines down to 1.
    const cleaned: string[] = [];
    let blankRun = 0;
    for (const l of formatted) {
        if (l === '') {
            blankRun++;
            if (blankRun <= 1) cleaned.push(l);
        } else {
            blankRun = 0;
            cleaned.push(l);
        }
    }
    return cleaned.join('\n');
}

const normalizeSetupStatement = (stmt: string): string => String(stmt || '').trim().replace(/\s+/g, ' ');

const isSimpleSerialBeginStatement = (stmt: string): boolean => {
    const normalized = normalizeSetupStatement(stmt);
    return /^Serial\s*\.\s*begin\s*\([^;]+\)\s*;$/i.test(normalized);
};

const isSimpleWireBeginStatement = (stmt: string): boolean => {
    const normalized = normalizeSetupStatement(stmt);
    return /^Wire\s*\.\s*begin\s*\(\s*\)\s*;$/i.test(normalized);
};

interface GeneratedSourceEntry {
    tag: string;
    code: string;
    origin: GeneratedArtifactOrigin | null;
}

const joinUniqueIncludeLines = (entries: GeneratedSourceEntry[]): string => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
        const lines = String(entry.code || '')
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(Boolean);
        if (lines.length === 0) continue;

        // Legacy helpers often register a complete conditional support block
        // through addInclude (for example the non-AVR MsTimer2 shim). Treat
        // those entries as atomic C++: line-level de-duplication would remove
        // repeated `}` lines and silently corrupt the generated program.
        const isPureIncludeEntry = lines.every(line => /^#\s*include\b/i.test(line));
        if (!isPureIncludeEntry) {
            const code = String(entry.code || '').trim();
            const norm = `block:${code.replace(/\s+/g, ' ')}`;
            if (seen.has(norm)) continue;
            seen.add(norm);
            out.push(wrapGeneratedFragment(
                code,
                entry.origin,
                'definition',
                'high',
                'd',
            ));
            continue;
        }

        for (const rawLine of lines) {
            const line = rawLine.trim();
            const norm = `include:${line.replace(/\s+/g, ' ')}`;
            if (seen.has(norm)) continue;
            seen.add(norm);
            out.push(wrapGeneratedFragment(
                line,
                entry.origin,
                'definition',
                'high',
                'd',
            ));
        }
    }
    return out.join('\n');
};

const splitDefinitionsForIncludes = (
    entries: GeneratedSourceEntry[],
): { includeEntries: GeneratedSourceEntry[]; definitionEntries: GeneratedSourceEntry[] } => {
    const includeEntries: GeneratedSourceEntry[] = [];
    const definitionEntries: GeneratedSourceEntry[] = [];
    const includeLineRe = /^\s*#\s*include\b/i;

    for (const entry of entries) {
        const includeLines: string[] = [];
        const definitionLines: string[] = [];
        for (const rawLine of entry.code.split(/\r?\n/)) {
            const line = rawLine.trim();
            if (!line) continue;
            if (includeLineRe.test(line)) {
                includeLines.push(line);
            } else {
                definitionLines.push(rawLine);
            }
        }
        if (includeLines.length > 0) {
            includeEntries.push({ ...entry, code: includeLines.join('\n') });
        }
        const definitionBlock = definitionLines.join('\n').trim();
        if (definitionBlock) {
            definitionEntries.push({ ...entry, code: definitionBlock });
        }
    }

    return { includeEntries, definitionEntries };
};

const sanitizeSetupStatements = (entries: GeneratedSourceEntry[]): GeneratedSourceEntry[] => {
    const out: GeneratedSourceEntry[] = [];
    const seenBlocks = new Set<string>();
    let wireBegin: GeneratedSourceEntry | null = null;
    let preferredSerialBegin: GeneratedSourceEntry | null = null;
    let fallbackSerialBegin: GeneratedSourceEntry | null = null;

    for (const entry of entries) {
        const rawCode = String(entry.code || '');
        if (!rawCode.trim()) continue;

        const keptLines: string[] = [];
        for (const rawLine of rawCode.split(/\r?\n/)) {
            const line = rawLine.trim();
            if (!line) continue;

            if (isSimpleSerialBeginStatement(line)) {
                const serialEntry = { ...entry, code: line };
                if (entry.tag === 'serial') {
                    preferredSerialBegin = serialEntry;
                } else {
                    fallbackSerialBegin = serialEntry;
                }
                continue;
            }
            if (isSimpleWireBeginStatement(line)) {
                if (!wireBegin) wireBegin = { ...entry, code: 'Wire.begin();' };
                continue;
            }
            keptLines.push(line);
        }

        const filteredCode = keptLines.join('\n').trim();
        if (!filteredCode) continue;
        const blockNorm = normalizeSetupStatement(filteredCode);
        if (seenBlocks.has(blockNorm)) continue;
        seenBlocks.add(blockNorm);
        out.push({ ...entry, code: filteredCode });
    }

    const prepend: GeneratedSourceEntry[] = [];
    const serialBegin = preferredSerialBegin || fallbackSerialBegin;
    if (serialBegin) {
        prepend.push(serialBegin);
    }
    if (wireBegin) {
        prepend.push(wireBegin);
    }

    return [...prepend, ...out];
};

// Initialize the generator
arduinoGenerator.init = function (_workspace) {
    resetSourceMapGenerationState();
    // Custom properties to store includes and setup code
    // @ts-ignore
    arduinoGenerator.includes_ = {};
    // @ts-ignore
    arduinoGenerator.setups_ = {};
    // @ts-ignore
    arduinoGenerator.definitions_ = {};
    // @ts-ignore
    arduinoGenerator.variables_ = {};
    // @ts-ignore
    arduinoGenerator.functions_ = {};
    // @ts-ignore
    arduinoGenerator.macros_ = {};
    // @ts-ignore
    arduinoGenerator.customGlobals_ = [];
    // @ts-ignore
    arduinoGenerator.customSetups_ = [];
    // @ts-ignore
    arduinoGenerator.customLoops_ = [];
    // @ts-ignore
    arduinoGenerator.__ckMsTimer2LoopHookAdded = false;
    // Clear per-generation pin tracking.
    _userExplicitPinModes.clear();
    // Ensure nameDB_ is ready for the workspace.
    ensureNameDbOnInit(arduinoGenerator, _workspace);
};

// Finsh generation: wrap code in Arduino structure
arduinoGenerator.finish = function (code) {
    // Deterministic ordering keeps generated code stable across repeated builds.
    // @ts-ignore
    const includesMap = arduinoGenerator.includes_ || {};
    // @ts-ignore
    const definitionsMap = arduinoGenerator.definitions_ || {};
    // @ts-ignore
    const variablesMap = arduinoGenerator.variables_ || {};
    // @ts-ignore
    const macrosMap = arduinoGenerator.macros_ || {};
    // @ts-ignore
    const functionsMap = arduinoGenerator.functions_ || {};
    // @ts-ignore
    const setupsMap = arduinoGenerator.setups_ || {};
    // @ts-ignore
    const customGlobalsList = arduinoGenerator.customGlobals_ || [];
    // @ts-ignore
    const customSetupsList = arduinoGenerator.customSetups_ || [];
    // @ts-ignore
    const customLoopsList = arduinoGenerator.customLoops_ || [];

    const includeEntries = generatedSourceEntries('includes_', includesMap);
    const definitionEntries = generatedSourceEntries('definitions_', definitionsMap);
    const { includeEntries: definitionIncludes, definitionEntries: definitionBlocks } =
        splitDefinitionsForIncludes(definitionEntries);

    const includes = joinUniqueIncludeLines([...includeEntries, ...definitionIncludes]);
    const wrapDefinitions = (entries: GeneratedSourceEntry[], separator = '\n'): string => entries
        .map(entry => wrapGeneratedFragment(
            entry.code,
            entry.origin,
            'definition',
            'high',
            'd',
        ))
        .filter(fragment => fragment.trim().length > 0)
        .join(separator);
    const macros = wrapDefinitions(generatedSourceEntries('macros_', macrosMap));
    const customGlobals = wrapDefinitions(generatedSourceEntries('customGlobals_', customGlobalsList));
    const variables = wrapDefinitions(generatedSourceEntries('variables_', variablesMap));
    const definitions = wrapDefinitions(definitionBlocks);
    const functions = wrapDefinitions(generatedSourceEntries('functions_', functionsMap), '\n\n');

    const setupEntries = generatedSourceEntries('setups_', setupsMap);
    const customSetupEntries = generatedSourceEntries('customSetups_', customSetupsList);
    const setupBody = sanitizeSetupStatements([...setupEntries, ...customSetupEntries])
        .map(entry => wrapGeneratedFragment(
            entry.code,
            entry.origin,
            'setup',
            'high',
            's',
        ))
        .join('\n');
    const customLoops = generatedSourceEntries('customLoops_', customLoopsList)
        .map(entry => wrapGeneratedFragment(
            entry.code,
            entry.origin,
            'loop',
            'high',
            'l',
        ))
        .join('\n');
    const loopBody = [customLoops, code].filter((part) => String(part).trim().length > 0).join('\n').trimEnd();

    const headers = [includes, macros, customGlobals, variables, definitions, functions].filter((part) => String(part).trim().length > 0).join('\n\n');
    const headerSection = headers ? `${headers}\n\n` : '';

    const setupSection = setupBody ? `void setup() {\n${setupBody}\n}` : 'void setup() {\n}';
    const loopSection = loopBody ? `void loop() {\n${loopBody}\n}` : 'void loop() {\n}';
    const finalCode = `${headerSection}${setupSection}\n\n${loopSection}`;

    // Clean up temporary data
    // @ts-ignore
    arduinoGenerator.includes_ = {};
    // @ts-ignore
    arduinoGenerator.setups_ = {};
    // @ts-ignore
    arduinoGenerator.definitions_ = {};
    // @ts-ignore
    arduinoGenerator.variables_ = {};
    // @ts-ignore
    arduinoGenerator.functions_ = {};
    // @ts-ignore
    arduinoGenerator.macros_ = {};

    const formatted = formatCpp(finalCode);
    // Build source map (line → block ID) and strip @ck markers from output.
    return _freezeGeneratedSourceMap(formatted);
};

arduinoGenerator.scrub_ = function (block, code, _thisOnly) {
    // Value blocks (outputConnection) are inlined in expressions — never add markers
    // or trailing newlines to them, as that would break the parent statement formatting.
    const isValueBlock = !!(block?.outputConnection);
    if (isValueBlock) {
        // Return the code as-is. Value blocks have no nextConnection to chain.
        return code;
    }

    code = addExpressionParentBoundaries(block, String(code || ''));
    code = wrapGeneratedFragment(
        code,
        sourceBlockMetadata(block),
        sourceSectionForStatement(block),
        'exact',
        'b',
    );

    // Tag the first non-empty line of each statement block with a source-map marker.
    // These markers are stripped before display but used to map compile errors → blocks.
    if (code && block?.id) {
        const firstNewlineIdx = code.indexOf('\n');
        if (firstNewlineIdx > 0) {
            code = code.substring(0, firstNewlineIdx) + ` ${createBlockMarkerComment(block.id)}` + code.substring(firstNewlineIdx);
        } else if (code.trim()) {
            code = code.trimEnd() + ` ${createBlockMarkerComment(block.id)}\n`;
        }
    }
    const nextBlock = block.nextConnection && block.nextConnection.targetBlock();
    const nextCode = nextBlock ? arduinoGenerator.blockToCode(nextBlock) : '';
    return code + nextCode;
};

// --- Helper Methods for External Generators ---

// @ts-ignore
arduinoGenerator.addInclude = function (tag: string, code: string) {
    // @ts-ignore
    if (!arduinoGenerator.includes_) arduinoGenerator.includes_ = {};
    // @ts-ignore
    if (Object.values(arduinoGenerator.includes_).includes(code)) return;
    // @ts-ignore
    arduinoGenerator.includes_[tag] = code;
};

// @ts-ignore
arduinoGenerator.addDeclaration = function (tag: string, code: string) {
    // @ts-ignore
    if (!arduinoGenerator.definitions_) arduinoGenerator.definitions_ = {};
    // @ts-ignore
    if (Object.values(arduinoGenerator.definitions_).includes(code)) return;
    // @ts-ignore
    arduinoGenerator.definitions_[tag] = code;
};

// @ts-ignore
arduinoGenerator.addSetup = function (tag: string, code: string) {
    // @ts-ignore
    if (!arduinoGenerator.setups_) arduinoGenerator.setups_ = {};
    // @ts-ignore
    if (Object.values(arduinoGenerator.setups_).includes(code)) return;
    // @ts-ignore
    arduinoGenerator.setups_[tag] = code;
};

// --- Legacy Compatibility Shims (Mixly/Old API) ---
// Ensures that old generator scripts copied from other projects still work.
// @ts-ignore
arduinoGenerator.setops_setup = arduinoGenerator.addSetup;
// @ts-ignore
arduinoGenerator.add_setup = arduinoGenerator.addSetup;
// @ts-ignore
arduinoGenerator.add_include = arduinoGenerator.addInclude;
// @ts-ignore
arduinoGenerator.add_declaration = arduinoGenerator.addDeclaration;


// --- Block Generators ---

arduinoGenerator.forBlock['board_pin_selector'] = function (block) {
    const rawPin = block.getFieldValue('PIN');
    const pin = normalizePinCodeToken(rawPin);
    if (!pin) {
        throw new Error(`当前板卡没有可生成的可信引脚：${String(rawPin || '未选择')}`);
    }
    return [pin, Order.ATOMIC];
};

arduinoGenerator.forBlock['set_pin_mode'] = function (block) {
    const pin = arduinoGenerator.valueToCode(block, 'PIN', Order.ATOMIC) || '0';
    const mode = block.getFieldValue('MODE');
    // Mark this pin as explicitly configured so auto-OUTPUT won't override.
    _userExplicitPinModes.add(String(pin).trim());
    const canonicalKey = `pinmode_pin_${sanitizeIdentifier(String(pin).trim())}`;
    // Remove any auto-generated OUTPUT setup for the same pin.
    // @ts-ignore
    delete (arduinoGenerator.setups_ || {})[canonicalKey];
    return `  pinMode(${pin}, ${mode});\n`;
};

arduinoGenerator.forBlock['write_digital'] = function (block) {
    const pin = arduinoGenerator.valueToCode(block, 'PIN', Order.ATOMIC) || '0';
    const level = arduinoGenerator.valueToCode(block, 'LEVEL', Order.ATOMIC)
        || block.getFieldValue('LEVEL')
        || 'HIGH';
    ensurePinOutputSetup(pin, 'write_digital');
    return `  digitalWrite(${pin}, ${level});\n`;
};

arduinoGenerator.forBlock['io_level'] = function (block) {
    const level = block.getFieldValue('LEVEL') || 'HIGH';
    return [level, Order.ATOMIC];
};

arduinoGenerator.forBlock['io_digital_write'] = function (block) {
    const pin = pinFromInputOrField(block, 'PIN', '0');
    const level = arduinoGenerator.valueToCode(block, 'LEVEL', Order.ATOMIC)
        || block.getFieldValue('LEVEL')
        || 'HIGH';
    ensurePinOutputSetup(pin, 'io_digital_write');
    return `  digitalWrite(${pin}, ${level});\n`;
};

arduinoGenerator.forBlock['io_digital_read'] = function (block) {
    const pin = pinFromInputOrField(block, 'PIN', '0');
    return [`digitalRead(${pin})`, Order.ATOMIC];
};

arduinoGenerator.forBlock['io_analog_write'] = function (block) {
    const pin = pinFromInputOrField(block, 'PIN', '3');
    const value = arduinoGenerator.valueToCode(block, 'VALUE', Order.ATOMIC) || '0';
    ensurePinOutputSetup(pin, 'io_analog_write');
    return `  analogWrite(${pin}, ${value});\n`;
};

arduinoGenerator.forBlock['io_analog_read'] = function (block) {
    const pin = pinFromInputOrField(block, 'PIN', 'A0');
    return [`analogRead(${pin})`, Order.ATOMIC];
};

arduinoGenerator.forBlock['io_soft_pwm_write'] = function (block) {
    const pin = pinFromInputOrField(block, 'PIN', '3');
    const value = arduinoGenerator.valueToCode(block, 'VALUE', Order.ATOMIC) || '0';
    ensurePinOutputSetup(pin, 'io_soft_pwm_write');
    // Fallback to analogWrite for cross-core compatibility.
    return `  analogWrite(${pin}, ${value});\n`;
};

arduinoGenerator.forBlock['io_soft_pwm_stop'] = function (block) {
    const pin = pinFromInputOrField(block, 'PIN', '3');
    ensurePinOutputSetup(pin, 'io_soft_pwm_stop');
    return `  analogWrite(${pin}, 0);\n`;
};

arduinoGenerator.forBlock['io_multi_button_event'] = function (block) {
    const pin = pinFromInputOrField(block, 'PIN', '0');
    const eventType = block.getFieldValue('EVENT') || 'SINGLE';
    const triggerLevel = arduinoGenerator.valueToCode(block, 'LEVEL', Order.ATOMIC)
        || block.getFieldValue('LEVEL')
        || 'HIGH';
    const branch = arduinoGenerator.statementToCode(block, 'DO');
    const sid = sanitizeIdentifier(block.id || `btn_${pin}_${eventType}`);
    const prefix = `ck_btn_${sid}`;
    const triggerExpr = `(${triggerLevel})`;
    const releaseExpr = `((${triggerLevel}) == LOW ? HIGH : LOW)`;

    // Ensure pin is configured as input by default.
    arduinoGenerator.addSetup(`button_mode_${sid}`, `pinMode(${pin}, INPUT);`);

    let eventCode = '';
    if (eventType === 'DOUBLE') {
        eventCode = `
    if (${prefix}_clicks >= 2) {
      ${prefix}_fire = true;
      ${prefix}_clicks = 0;
    } else if (${prefix}_clicks == 1 && (${prefix}_now - ${prefix}_lastRelease) > 350) {
      ${prefix}_clicks = 0;
    }`;
    } else if (eventType === 'LONG') {
        eventCode = `
    if (${prefix}_stable == ${triggerExpr} && !${prefix}_longFired && (${prefix}_now - ${prefix}_pressStart) > 700) {
      ${prefix}_fire = true;
      ${prefix}_longFired = true;
      ${prefix}_clicks = 0;
    }`;
    } else {
        eventCode = `
    if (${prefix}_clicks == 1 && (${prefix}_now - ${prefix}_lastRelease) > 260) {
      ${prefix}_fire = true;
      ${prefix}_clicks = 0;
    }`;
    }

    return `  {
    static int ${prefix}_last = -1;
    static int ${prefix}_stable = -1;
    static unsigned long ${prefix}_changedAt = 0;
    static unsigned long ${prefix}_pressStart = 0;
    static unsigned long ${prefix}_lastRelease = 0;
    static uint8_t ${prefix}_clicks = 0;
    static bool ${prefix}_longFired = false;
    int ${prefix}_reading = digitalRead(${pin});
    unsigned long ${prefix}_now = millis();
    bool ${prefix}_fire = false;

    if (${prefix}_last == -1) {
      ${prefix}_last = ${prefix}_reading;
      ${prefix}_stable = ${prefix}_reading;
      ${prefix}_changedAt = ${prefix}_now;
    }

    if (${prefix}_reading != ${prefix}_last) {
      ${prefix}_last = ${prefix}_reading;
      ${prefix}_changedAt = ${prefix}_now;
    }

    if ((${prefix}_now - ${prefix}_changedAt) > 25 && ${prefix}_reading != ${prefix}_stable) {
      ${prefix}_stable = ${prefix}_reading;
      if (${prefix}_stable == ${triggerExpr}) {
        ${prefix}_pressStart = ${prefix}_now;
        ${prefix}_longFired = false;
      } else if (${prefix}_stable == ${releaseExpr}) {
        if ((${prefix}_now - ${prefix}_pressStart) <= 700) {
          ${prefix}_clicks++;
        }
        ${prefix}_lastRelease = ${prefix}_now;
      }
    }${eventCode}

    if (${prefix}_fire) {
${branch}    }
  }\n`;
};

arduinoGenerator.forBlock['io_hardware_interrupt_event'] = function (block) {
    const pin = pinFromInputOrField(block, 'PIN', '2');
    const mode = block.getFieldValue('MODE') || 'RISING';
    const branch = arduinoGenerator.statementToCode(block, 'DO');
    const sid = sanitizeIdentifier(block.id || `irq_${pin}_${mode}`);
    const flagName = `ck_irq_flag_${sid}`;
    const isrName = `ck_irq_isr_${sid}`;

    arduinoGenerator.addDeclaration(flagName, `volatile bool ${flagName} = false;`);
    arduinoGenerator.addDeclaration(isrName, `void ${isrName}() { ${flagName} = true; }`);
    arduinoGenerator.addSetup(`irq_mode_${sid}`, `pinMode(${pin}, INPUT);`);
    arduinoGenerator.addSetup(`irq_attach_${sid}`, `attachInterrupt(digitalPinToInterrupt(${pin}), ${isrName}, ${mode});`);

    return `  if (${flagName}) {
    ${flagName} = false;
${branch}  }\n`;
};

arduinoGenerator.forBlock['io_hardware_interrupt_detach'] = function (block) {
    const pin = pinFromInputOrField(block, 'PIN', '2');
    return `  detachInterrupt(digitalPinToInterrupt(${pin}));\n`;
};

arduinoGenerator.forBlock['io_software_interrupt_event'] = function (block) {
    const pin = pinFromInputOrField(block, 'PIN', '0');
    const mode = block.getFieldValue('MODE') || 'RISING';
    const branch = arduinoGenerator.statementToCode(block, 'DO');
    const pinSid = sanitizeIdentifier(String(pin));
    const sid = sanitizeIdentifier(block.id || `softirq_${pin}_${mode}`);
    const enableVar = `ck_softirq_enabled_${pinSid}`;
    const lastVar = `ck_softirq_last_${sid}`;
    const readingVar = `ck_softirq_read_${sid}`;

    arduinoGenerator.addDeclaration(enableVar, `bool ${enableVar} = true;`);
    arduinoGenerator.addSetup(`softirq_mode_${pinSid}`, `pinMode(${pin}, INPUT);`);

    let edgeExpr = `${lastVar} != ${readingVar}`;
    if (mode === 'RISING') {
        edgeExpr = `${lastVar} == LOW && ${readingVar} == HIGH`;
    } else if (mode === 'FALLING') {
        edgeExpr = `${lastVar} == HIGH && ${readingVar} == LOW`;
    }

    return `  {
    static int ${lastVar} = -1;
    int ${readingVar} = digitalRead(${pin});
    if (${lastVar} == -1) {
      ${lastVar} = ${readingVar};
    } else if (${enableVar} && (${edgeExpr})) {
${branch}      ${lastVar} = ${readingVar};
    } else {
      ${lastVar} = ${readingVar};
    }
  }\n`;
};

arduinoGenerator.forBlock['io_software_interrupt_cancel'] = function (block) {
    const pin = pinFromInputOrField(block, 'PIN', '0');
    const pinSid = sanitizeIdentifier(String(pin));
    const enableVar = `ck_softirq_enabled_${pinSid}`;
    arduinoGenerator.addDeclaration(enableVar, `bool ${enableVar} = true;`);
    return `  ${enableVar} = false;\n`;
};

arduinoGenerator.forBlock['io_pulse_in'] = function (block) {
    const pin = pinFromInputOrField(block, 'PIN', '0');
    const state = arduinoGenerator.valueToCode(block, 'STATE', Order.ATOMIC)
        || block.getFieldValue('STATE')
        || 'HIGH';
    return [`pulseIn(${pin}, ${state})`, Order.ATOMIC];
};

arduinoGenerator.forBlock['io_pulse_in_timeout'] = function (block) {
    const pin = pinFromInputOrField(block, 'PIN', '0');
    const state = arduinoGenerator.valueToCode(block, 'STATE', Order.ATOMIC)
        || block.getFieldValue('STATE')
        || 'HIGH';
    const timeout = arduinoGenerator.valueToCode(block, 'TIMEOUT', Order.ATOMIC) || '1000000';
    return [`pulseIn(${pin}, ${state}, ${timeout})`, Order.ATOMIC];
};

arduinoGenerator.forBlock['io_pulse_in_long'] = function (block) {
    const pin = pinFromInputOrField(block, 'PIN', '0');
    const state = arduinoGenerator.valueToCode(block, 'STATE', Order.ATOMIC)
        || block.getFieldValue('STATE')
        || 'HIGH';
    const timeout = arduinoGenerator.valueToCode(block, 'TIMEOUT', Order.ATOMIC) || '1000000';
    return [`pulseInLong(${pin}, ${state}, ${timeout})`, Order.ATOMIC];
};

arduinoGenerator.forBlock['io_shift_out'] = function (block) {
    const dataPin = pinFromInputOrField(block, 'DATA_PIN', '0');
    const clockPin = pinFromInputOrField(block, 'CLOCK_PIN', '0');
    const order = block.getFieldValue('ORDER') || 'MSBFIRST';
    const value = arduinoGenerator.valueToCode(block, 'VALUE', Order.ATOMIC) || '0';
    const sid = sanitizeIdentifier(`${dataPin}_${clockPin}`);
    arduinoGenerator.addSetup(`shiftout_data_${sid}`, `pinMode(${dataPin}, OUTPUT);`);
    arduinoGenerator.addSetup(`shiftout_clk_${sid}`, `pinMode(${clockPin}, OUTPUT);`);
    return `  shiftOut(${dataPin}, ${clockPin}, ${order}, ${value});\n`;
};

arduinoGenerator.forBlock['io_shift_in'] = function (block) {
    const dataPin = pinFromInputOrField(block, 'DATA_PIN', '0');
    const clockPin = pinFromInputOrField(block, 'CLOCK_PIN', '0');
    const order = block.getFieldValue('ORDER') || 'MSBFIRST';
    const sid = sanitizeIdentifier(`${dataPin}_${clockPin}`);
    arduinoGenerator.addSetup(`shiftin_data_${sid}`, `pinMode(${dataPin}, INPUT);`);
    arduinoGenerator.addSetup(`shiftin_clk_${sid}`, `pinMode(${clockPin}, OUTPUT);`);
    return [`shiftIn(${dataPin}, ${clockPin}, ${order})`, Order.ATOMIC];
};

arduinoGenerator.forBlock['io_interrupts_disable'] = function (_block) {
    return `  noInterrupts();\n`;
};

arduinoGenerator.forBlock['io_interrupts_enable'] = function (_block) {
    return `  interrupts();\n`;
};

arduinoGenerator.forBlock['io_micros_now'] = function (_block) {
    return ['micros()', Order.ATOMIC];
};

arduinoGenerator.forBlock['io_delay_us'] = function (block) {
    const us = arduinoGenerator.valueToCode(block, 'US', Order.ATOMIC) || '100';
    return `  delayMicroseconds(${us});\n`;
};

arduinoGenerator.forBlock['control_delay'] = function (block) {
    const time = arduinoGenerator.valueToCode(block, 'TIME', Order.ATOMIC) || '1000';
    const unit = block.getFieldValue('UNIT') || 'MS';
    if (unit === 'US') {
        return `  delayMicroseconds(${time});\n`;
    }
    return `  delay(${time});\n`;
};

arduinoGenerator.forBlock['controls_delay'] = function (block) {
    const time =
        arduinoGenerator.valueToCode(block, 'DELAY_TIME', Order.ATOMIC)
        || arduinoGenerator.valueToCode(block, 'TIME', Order.ATOMIC)
        || '1000';
    const unitRaw = String(block.getFieldValue('UNIT') || 'delay').trim();
    const normalized = unitRaw.toUpperCase();
    if (unitRaw === 'delayMicroseconds' || normalized === 'US') {
        return `  delayMicroseconds(${time});\n`;
    }
    return `  delay(${time});\n`;
};

arduinoGenerator.forBlock['io_softpwm_write'] = arduinoGenerator.forBlock['io_soft_pwm_write'];
arduinoGenerator.forBlock['io_softpwm_stop'] = arduinoGenerator.forBlock['io_soft_pwm_stop'];
arduinoGenerator.forBlock['io_button_event'] = arduinoGenerator.forBlock['io_multi_button_event'];
arduinoGenerator.forBlock['io_interrupt_event'] = arduinoGenerator.forBlock['io_hardware_interrupt_event'];
arduinoGenerator.forBlock['io_interrupt_detach'] = arduinoGenerator.forBlock['io_hardware_interrupt_detach'];
arduinoGenerator.forBlock['io_soft_interrupt_event'] = arduinoGenerator.forBlock['io_software_interrupt_event'];
arduinoGenerator.forBlock['io_soft_interrupt_cancel'] = arduinoGenerator.forBlock['io_software_interrupt_cancel'];
arduinoGenerator.forBlock['io_pulsein'] = arduinoGenerator.forBlock['io_pulse_in'];
arduinoGenerator.forBlock['io_pulsein_timeout'] = arduinoGenerator.forBlock['io_pulse_in_timeout'];
arduinoGenerator.forBlock['io_pulsein_long'] = arduinoGenerator.forBlock['io_pulse_in_long'];
arduinoGenerator.forBlock['io_shiftout'] = arduinoGenerator.forBlock['io_shift_out'];
arduinoGenerator.forBlock['io_shiftin'] = arduinoGenerator.forBlock['io_shift_in'];

arduinoGenerator.forBlock['write_servo'] = function (block) {
    const pin = arduinoGenerator.valueToCode(block, 'PIN', Order.ATOMIC) || '9';
    const angle = block.getFieldValue('ANGLE');

    // Add include and setup dynamically
    // @ts-ignore
    arduinoGenerator.includes_['servo'] = '#include <Servo.h>';
    // @ts-ignore
    arduinoGenerator.setups_[`servo_${pin}`] = `servo_${pin}.attach(${pin});`;
    // @ts-ignore
    arduinoGenerator.includes_[`var_servo_${pin}`] = `Servo servo_${pin};`;

    return `  servo_${pin}.write(${angle});\n`;
};

arduinoGenerator.forBlock['serial_print'] = function (block) {
    // Blockly throws when valueToCode is called for an input that is not part
    // of the active block definition. Probe legacy aliases before reading
    // them so the current MSG block and old CONTENT/VALUE projects both work.
    const msgInput = ['MSG', 'CONTENT', 'VALUE']
        .find(name => Boolean(block.getInput?.(name)));
    const msg = (msgInput
        ? arduinoGenerator.valueToCode(block, msgInput, Order.ATOMIC)
        : '') || '"Hello World"';
    ensureSerialSetup();

    const newlineRaw =
        String(block.getFieldValue('NEWLINE') || block.getFieldValue('new_line') || 'TRUE').trim();
    const normalized = newlineRaw.toLowerCase();
    const noNewline = newlineRaw === 'FALSE' || normalized === 'print';
    if (noNewline) {
        return `  Serial.print(${msg});\n`;
    }
    return `  Serial.println(${msg});\n`;
};

arduinoGenerator.forBlock['serial_println'] = function (block) {
    const msg =
        arduinoGenerator.valueToCode(block, 'CONTENT', Order.ATOMIC)
        || arduinoGenerator.valueToCode(block, 'MSG', Order.ATOMIC)
        || arduinoGenerator.valueToCode(block, 'VALUE', Order.ATOMIC)
        || '"Hello World"';
    ensureSerialSetup();
    const modeRaw = String(block.getFieldValue('new_line') || block.getFieldValue('NEWLINE') || 'println').trim().toLowerCase();
    if (modeRaw === 'print' || modeRaw === 'false') {
        return `  Serial.print(${msg});\n`;
    }
    return `  Serial.println(${msg});\n`;
};

arduinoGenerator.forBlock['serial_begin'] = function (block) {
    const baud = arduinoGenerator.valueToCode(block, 'CONTENT', Order.ATOMIC)
        || arduinoGenerator.valueToCode(block, 'BAUD', Order.ATOMIC)
        || block.getFieldValue('BAUD')
        || '9600';
    // @ts-ignore
    arduinoGenerator.setups_['serial'] = `Serial.begin(${baud});`;
    return '';
};

arduinoGenerator.forBlock['serial_setup'] = function (block) {
    const baud = arduinoGenerator.valueToCode(block, 'BAUD', Order.ATOMIC)
        || block.getFieldValue('BAUD')
        || '9600';
    // @ts-ignore
    arduinoGenerator.setups_['serial'] = `Serial.begin(${baud});`;
    return '';
};

arduinoGenerator.forBlock['serial_baudrate_selector'] = function (block) {
    const baud = block.getFieldValue('BAUD') || '115200';
    return [baud, Order.ATOMIC];
};

arduinoGenerator.forBlock['serial_setup_with_pins'] = function (block) {
    const port = block.getFieldValue('PORT') || 'Serial';
    const baud = arduinoGenerator.valueToCode(block, 'BAUD', Order.ATOMIC) || '9600';
    const rx = arduinoGenerator.valueToCode(block, 'RX', Order.ATOMIC) || '0';
    const tx = arduinoGenerator.valueToCode(block, 'TX', Order.ATOMIC) || '1';
    if (port === 'Serial') {
        // @ts-ignore
        arduinoGenerator.setups_['serial'] = `Serial.begin(${baud});`;
        return '';
    }
    const guard = port === 'Serial1' ? 'defined(HAVE_HWSERIAL1)' : 'defined(HAVE_HWSERIAL2)';
    arduinoGenerator.addSetup(
        `ck_serial_port_init_${port.toLowerCase()}_${sanitizeIdentifier(rx)}_${sanitizeIdentifier(tx)}`,
        `#if defined(ARDUINO_ARCH_ESP32)\n  ${port}.begin(${baud}, SERIAL_8N1, ${rx}, ${tx});\n#elif ${guard}\n  ${port}.begin(${baud});\n#endif`,
    );
    return '';
};

arduinoGenerator.forBlock['serial_available'] = function (block) {
    ensureSerialSetup();
    const code = 'Serial.available() > 0';
    return [code, Order.ATOMIC];
};

arduinoGenerator.forBlock['serial_read_string'] = function (block) {
    ensureSerialSetup();
    const code = 'Serial.readString()';
    return [code, Order.ATOMIC];
};

arduinoGenerator.forBlock['serial_read_string_until'] = function (block) {
    ensureSerialSetup();
    const delimLiteral = charLiteralFromField(block.getFieldValue('DELIM'));
    return [`Serial.readStringUntil(${delimLiteral})`, Order.ATOMIC];
};

arduinoGenerator.forBlock['serial_read_byte'] = function (_block) {
    ensureSerialSetup();
    return ['Serial.read()', Order.ATOMIC];
};

arduinoGenerator.forBlock['serial_flush_input'] = function (_block) {
    ensureSerialSetup();
    return `  while (Serial.available() > 0) { Serial.read(); }\n`;
};

arduinoGenerator.forBlock['serial_write_raw'] = function (block) {
    ensureSerialSetup();
    const data = arduinoGenerator.valueToCode(block, 'DATA', Order.ATOMIC) || '0';
    return `  Serial.write(${data});\n`;
};

arduinoGenerator.forBlock['serial_print_number'] = function (block) {
    ensureSerialSetup();
    const num = arduinoGenerator.valueToCode(block, 'NUM', Order.ATOMIC) || '0';
    const newline = block.getFieldValue('NEWLINE') || 'FALSE';
    const base = block.getFieldValue('BASE') || 'DEC';
    const method = newline === 'TRUE' ? 'println' : 'print';
    if (base === 'DEC') {
        return `  Serial.${method}(${num});\n`;
    }
    return `  Serial.${method}(${num}, ${base});\n`;
};

arduinoGenerator.forBlock['serial_read_if_available'] = function (block) {
    ensureSerialSetup();
    const branch = arduinoGenerator.statementToCode(block, 'DO');
    return `  if (Serial.available() > 0) {\n${branch}  }\n`;
};

arduinoGenerator.forBlock['delay_ms'] = function (block) {
    const ms = block.getFieldValue('MS');
    return `  delay(${ms});\n`;
};

arduinoGenerator.forBlock['control_system_runtime'] = function (block) {
    const unit = block.getFieldValue('UNIT') || 'MS';
    if (unit === 'US') {
        return ['micros()', Order.ATOMIC];
    }
    if (unit === 'S') {
        return ['(millis() / 1000UL)', Order.ATOMIC];
    }
    return ['millis()', Order.ATOMIC];
};

arduinoGenerator.forBlock['control_mstimer2_every'] = function (block) {
    ensureMsTimer2Support();
    const interval = arduinoGenerator.valueToCode(block, 'INTERVAL', Order.ATOMIC)
        || block.getFieldValue('INTERVAL')
        || '500';
    const branch = arduinoGenerator.statementToCode(block, 'DO');
    const callbackBody = String(branch).trim().length > 0
        ? branch
        : '  ;\n';

    arduinoGenerator.addDeclaration('ck_mstimer2_callback', `void ck_mstimer2_callback() {\n${callbackBody}}\n`);
    arduinoGenerator.addSetup('ck_mstimer2_set', `MsTimer2::set(${interval}, ck_mstimer2_callback);`);
    return '';
};

arduinoGenerator.forBlock['control_mstimer2_start'] = function (_block) {
    ensureMsTimer2Support();
    return `  MsTimer2::start();\n`;
};

arduinoGenerator.forBlock['control_mstimer2_stop'] = function (_block) {
    ensureMsTimer2Support();
    return `  MsTimer2::stop();\n`;
};

arduinoGenerator.forBlock['control_simple_timer_interval'] = function (block) {
    const slot = sanitizeIdentifier(block.getFieldValue('SLOT') || '1');
    const interval = arduinoGenerator.valueToCode(block, 'INTERVAL', Order.ATOMIC)
        || block.getFieldValue('INTERVAL')
        || '1000';
    const branch = arduinoGenerator.statementToCode(block, 'DO');
    const loopBody = String(branch).trim().length > 0
        ? branch
        : '      ;\n';
    const nowVar = `ck_simple_timer_now_${slot}`;
    const lastVar = `ck_simple_timer_last_${slot}`;
    const intervalVar = `ck_simple_timer_interval_${slot}`;

    return `  {
    static unsigned long ${lastVar} = 0;
    unsigned long ${nowVar} = millis();
    unsigned long ${intervalVar} = (${interval}) <= 0 ? 1 : (${interval});
    if ((${nowVar} - ${lastVar}) >= ${intervalVar}) {
      ${lastVar} = ${nowVar};
${loopBody}    }
  }\n`;
};

arduinoGenerator.forBlock['controls_global_defs_custom'] = function (block) {
    const branch = arduinoGenerator.statementToCode(block, 'DO');
    const dedented = String(branch || '')
        .split('\n')
        .map((line) => line.replace(/^  /, ''))
        .join('\n')
        .trim();
    if (dedented.length > 0) {
        // @ts-ignore
        arduinoGenerator.customGlobals_.push(dedented);
    }
    return '';
};

arduinoGenerator.forBlock['controls_setup_custom'] = function (block) {
    const branch = arduinoGenerator.statementToCode(block, 'DO');
    if (String(branch).trim().length > 0) {
        // @ts-ignore
        arduinoGenerator.customSetups_.push(branch.trimEnd());
    }
    return '';
};

arduinoGenerator.forBlock['controls_loop_custom'] = function (block) {
    const branch = arduinoGenerator.statementToCode(block, 'DO');
    if (String(branch).trim().length > 0) {
        // @ts-ignore
        arduinoGenerator.customLoops_.push(branch.trimEnd());
    }
    return '';
};

// Backward compatibility for legacy project block types.
arduinoGenerator.forBlock['arduino_setup'] = arduinoGenerator.forBlock['controls_setup_custom'];
arduinoGenerator.forBlock['arduino_loop'] = arduinoGenerator.forBlock['controls_loop_custom'];
arduinoGenerator.forBlock['base_setup'] = arduinoGenerator.forBlock['controls_setup_custom'];
arduinoGenerator.forBlock['base_loop'] = arduinoGenerator.forBlock['controls_loop_custom'];

arduinoGenerator.forBlock['controls_whileUntil'] = function (block) {
    const mode = block.getFieldValue('MODE') || 'WHILE';
    let condition = arduinoGenerator.valueToCode(block, 'BOOL', Order.ATOMIC) || 'false';
    if (mode === 'UNTIL') {
        condition = `!(${condition})`;
    }
    let branch = arduinoGenerator.statementToCode(block, 'DO');
    // @ts-ignore
    branch = arduinoGenerator.addLoopTrap(branch, block);
    return `  while (${condition}) {\n${branch}  }\n`;
};

// Standard logic blocks mapping (simplified)
arduinoGenerator.forBlock['controls_repeat_ext'] = function (block) {
    // Repeat n times
    let repeats;
    // @ts-ignore
    if (block.getField('TIMES')) {
        repeats = String(Number(block.getFieldValue('TIMES')));
    } else {
        repeats = arduinoGenerator.valueToCode(block, 'TIMES', Order.ATOMIC) || '0';
    }

    let branch = arduinoGenerator.statementToCode(block, 'DO');
    // @ts-ignore
    branch = arduinoGenerator.addLoopTrap(branch, block);

    return `  for (int i = 0; i < ${repeats}; i++) {\n${branch}  }\n`;
};

arduinoGenerator.forBlock['controls_for'] = function (block) {
    // For loop: supports positive and negative step.
    const variable0 = block.getField('VAR')?.getText() || 'i';
    const argument0 = arduinoGenerator.valueToCode(block, 'FROM', Order.ATOMIC) || '0';
    const argument1 = arduinoGenerator.valueToCode(block, 'TO', Order.ATOMIC) || '0';
    const argument2 = arduinoGenerator.valueToCode(block, 'BY', Order.ATOMIC) || '1';
    let branch = arduinoGenerator.statementToCode(block, 'DO');
    // @ts-ignore
    branch = arduinoGenerator.addLoopTrap(branch, block);

    return `  for (int ${variable0} = ${argument0}; (${argument2}) >= 0 ? ${variable0} <= ${argument1} : ${variable0} >= ${argument1}; ${variable0} += (${argument2})) {\n${branch}  }\n`;
};

arduinoGenerator.forBlock['controls_if'] = function (block) {
    // If / else if / else (with mutator).
    let n = 0;
    let code = '';
    while (block.getInput('IF' + n)) {
        const condition = arduinoGenerator.valueToCode(block, 'IF' + n, Order.ATOMIC) || 'false';
        const branch = arduinoGenerator.statementToCode(block, 'DO' + n);
        code += (n === 0 ? `  if (${condition}) {\n${branch}  }` : ` else if (${condition}) {\n${branch}  }`);
        n++;
    }
    if (block.getInput('ELSE')) {
        const branch = arduinoGenerator.statementToCode(block, 'ELSE');
        code += ` else {\n${branch}  }`;
    }
    return code + '\n';
};

arduinoGenerator.forBlock['controls_do_while_custom'] = function (block) {
    const condition = arduinoGenerator.valueToCode(block, 'COND', Order.ATOMIC) || 'false';
    let branch = arduinoGenerator.statementToCode(block, 'DO');
    // @ts-ignore
    branch = arduinoGenerator.addLoopTrap(branch, block);
    return `  do {\n${branch}  } while (${condition});\n`;
};

arduinoGenerator.forBlock['controls_flow_action_custom'] = function (block) {
    const action = block.getFieldValue('ACTION') || 'BREAK';
    if (action === 'CONTINUE') return `  continue;\n`;
    if (action === 'RETURN') return `  return;\n`;
    return `  break;\n`;
};

arduinoGenerator.forBlock['controls_label_custom'] = function (block) {
    const rawLabel = block.getFieldValue('LABEL') || 'label1';
    const label = sanitizeIdentifier(rawLabel);
    return `  ${label}: ;\n`;
};

arduinoGenerator.forBlock['controls_goto_custom'] = function (block) {
    const rawLabel = block.getFieldValue('LABEL') || 'label1';
    const label = sanitizeIdentifier(rawLabel);
    return `  goto ${label};\n`;
};

arduinoGenerator.forBlock['controls_flow_statements'] = function (block) {
    const flow = block.getFieldValue('FLOW') || 'BREAK';
    return flow === 'CONTINUE' ? `  continue;\n` : `  break;\n`;
};

arduinoGenerator.forBlock['procedures_defnoreturn'] = function (block) {
    const name = sanitizeVariableName(block.getFieldValue('NAME') || 'myFunction');
    const args = getProcedureArgNames(block).map((arg) => `int ${arg}`).join(', ');
    const branch = arduinoGenerator.statementToCode(block, 'STACK');
    const body = String(branch).trim().length > 0 ? branch : '';
    arduinoGenerator.addDeclaration(`fn_${name}`, `void ${name}(${args}) {\n${body}}\n`);
    return '';
};

arduinoGenerator.forBlock['procedures_defreturn'] = function (block) {
    const name = sanitizeVariableName(block.getFieldValue('NAME') || 'myValue');
    const args = getProcedureArgNames(block).map((arg) => `int ${arg}`).join(', ');
    const returnType = normalizeProcedureReturnType(block.getFieldValue('RET_TYPE') || 'int');
    const branch = arduinoGenerator.statementToCode(block, 'STACK');
    const returnExprRaw = arduinoGenerator.valueToCode(block, 'RETURN', Order.ATOMIC) || defaultValueForType(returnType);
    const returnExpr = castProcedureReturnValue(returnType, returnExprRaw);
    const bodyPrefix = String(branch).trim().length > 0 ? branch : '';
    arduinoGenerator.addDeclaration(
        `fn_${name}`,
        `${returnType} ${name}(${args}) {\n${bodyPrefix}  return ${returnExpr};\n}\n`
    );
    return '';
};

arduinoGenerator.forBlock['procedures_callreturn'] = function (block) {
    const name = sanitizeVariableName(block.getFieldValue('NAME') || 'myValue');
    const argNames = getProcedureArgNames(block);
    const args = argNames.map((_, i) => arduinoGenerator.valueToCode(block, `ARG${i}`, Order.ATOMIC) || '0');
    return [`${name}(${args.join(', ')})`, Order.ATOMIC];
};

arduinoGenerator.forBlock['procedures_callnoreturn'] = function (block) {
    const callCode = arduinoGenerator.forBlock['procedures_callreturn'](block)[0];
    return `  ${callCode};\n`;
};

arduinoGenerator.forBlock['procedures_callnoreturn_picker'] = function (block) {
    const name = sanitizeVariableName(block.getFieldValue('NAME') || 'myFunction');
    return `  ${name}();\n`;
};

arduinoGenerator.forBlock['procedures_callreturn_picker'] = function (block) {
    const name = sanitizeVariableName(block.getFieldValue('NAME') || 'myValue');
    return [`${name}()`, Order.ATOMIC];
};

arduinoGenerator.forBlock['procedures_ifreturn'] = function (block) {
    const condition = arduinoGenerator.valueToCode(block, 'CONDITION', Order.ATOMIC) || 'false';
    let code = `  if (${condition}) {\n`;
    if ((block as any).hasReturnValue_) {
        const inferred = inferEnclosingProcedureReturnType(block);
        const valueRaw = arduinoGenerator.valueToCode(block, 'VALUE', Order.ATOMIC) || '0';
        if (inferred === 'void') {
            code += `    return;\n`;
        } else if (inferred !== 'auto') {
            code += `    return ${castProcedureReturnValue(inferred, valueRaw)};\n`;
        } else {
            code += `    return ${valueRaw};\n`;
        }
    } else {
        code += `    return;\n`;
    }
    code += `  }\n`;
    return code;
};

arduinoGenerator.forBlock['procedures_return_void_custom'] = function (_block) {
    return `  return;\n`;
};

arduinoGenerator.forBlock['procedures_return_value_custom'] = function (block) {
    const inferred = inferEnclosingProcedureReturnType(block);
    const valueRaw = arduinoGenerator.valueToCode(block, 'VALUE', Order.ATOMIC) || '0';
    if (inferred === 'void') return `  return;\n`;
    if (inferred !== 'auto') return `  return ${castProcedureReturnValue(inferred, valueRaw)};\n`;
    return `  return ${valueRaw};\n`;
};

arduinoGenerator.forBlock['procedures_return_typed_custom'] = function (block) {
    const typeName = normalizeProcedureReturnType(block.getFieldValue('TYPE') || 'int');
    const valueRaw = arduinoGenerator.valueToCode(block, 'VALUE', Order.ATOMIC) || defaultValueForType(typeName);
    return `  return ${castProcedureReturnValue(typeName, valueRaw)};\n`;
};

arduinoGenerator.forBlock['procedures_ifreturn_value_custom'] = function (block) {
    const cond = arduinoGenerator.valueToCode(block, 'COND', Order.ATOMIC) || 'false';
    const inferred = inferEnclosingProcedureReturnType(block);
    const valueRaw = arduinoGenerator.valueToCode(block, 'VALUE', Order.ATOMIC) || '0';
    let returnCode = 'return;';
    if (inferred !== 'void') {
        returnCode = inferred !== 'auto'
            ? `return ${castProcedureReturnValue(inferred, valueRaw)};`
            : `return ${valueRaw};`;
    }
    return `  if (${cond}) {\n    ${returnCode}\n  }\n`;
};

arduinoGenerator.forBlock['procedures_ifreturn_void_custom'] = function (block) {
    const cond = arduinoGenerator.valueToCode(block, 'COND', Order.ATOMIC) || 'false';
    return `  if (${cond}) {\n    return;\n  }\n`;
};

arduinoGenerator.forBlock['controls_switch_custom'] = function (block) {
    const condition = arduinoGenerator.valueToCode(block, 'COND', Order.ATOMIC) || '0';
    const caseCount = Number((block as any).caseCount_ || 0);
    const hasDefault = !!(block as any).hasDefault_;
    let code = `  switch (${condition}) {\n`;

    for (let i = 0; i < caseCount; i++) {
        const caseValue = arduinoGenerator.valueToCode(block, `CASE_VAL${i}`, Order.ATOMIC) || '0';
        const caseBranch = arduinoGenerator.statementToCode(block, `CASE_DO${i}`);
        const needsBreak = !/\b(?:break|continue|return)\s*;\s*$/.test(String(caseBranch).trim());
        code += `    case ${caseValue}: {\n${caseBranch}`;
        if (needsBreak) {
            code += `      break;\n`;
        }
        code += `    }\n`;
    }

    if (hasDefault) {
        const defaultBranch = arduinoGenerator.statementToCode(block, 'DEFAULT');
        code += `    default: {\n${defaultBranch}    }\n`;
    }

    code += `  }\n`;
    return code;
};

arduinoGenerator.forBlock['logic_boolean'] = function (block) {
    const code = block.getFieldValue('BOOL') === 'TRUE' ? 'true' : 'false';
    return [code, Order.ATOMIC];
};

arduinoGenerator.forBlock['logic_compare'] = function (block) {
    const OPERATORS: Record<string, string> = {
        'EQ': '==',
        'NEQ': '!=',
        'LT': '<',
        'LTE': '<=',
        'GT': '>',
        'GTE': '>=',
    };
    const op = OPERATORS[block.getFieldValue('OP')] || '==';
    const argument0 = arduinoGenerator.valueToCode(block, 'A', Order.ATOMIC) || '0';
    const argument1 = arduinoGenerator.valueToCode(block, 'B', Order.ATOMIC) || '0';
    return [`(${argument0} ${op} ${argument1})`, Order.ATOMIC];
};

arduinoGenerator.forBlock['logic_operation'] = function (block) {
    const op = block.getFieldValue('OP') === 'OR' ? '||' : '&&';
    const argument0 = arduinoGenerator.valueToCode(block, 'A', Order.ATOMIC) || 'false';
    const argument1 = arduinoGenerator.valueToCode(block, 'B', Order.ATOMIC) || 'false';
    return [`(${argument0} ${op} ${argument1})`, Order.ATOMIC];
};

arduinoGenerator.forBlock['logic_negate'] = function (block) {
    const argument0 = arduinoGenerator.valueToCode(block, 'BOOL', Order.ATOMIC) || 'false';
    return [`!(${argument0})`, Order.ATOMIC];
};

arduinoGenerator.forBlock['logic_ternary'] = function (block) {
    const condition = arduinoGenerator.valueToCode(block, 'IF', Order.ATOMIC) || 'false';
    const ifTrue = arduinoGenerator.valueToCode(block, 'THEN', Order.ATOMIC) || '0';
    const ifFalse = arduinoGenerator.valueToCode(block, 'ELSE', Order.ATOMIC) || '0';
    return [`((${condition}) ? (${ifTrue}) : (${ifFalse}))`, Order.ATOMIC];
};

arduinoGenerator.forBlock['logic_ternary_stmt_custom'] = function (block) {
    const condition = arduinoGenerator.valueToCode(block, 'IF', Order.ATOMIC) || 'false';
    const ifTrue = arduinoGenerator.valueToCode(block, 'THEN', Order.ATOMIC) || '0';
    const ifFalse = arduinoGenerator.valueToCode(block, 'ELSE', Order.ATOMIC) || '0';
    return `  ((${condition}) ? (${ifTrue}) : (${ifFalse}));\n`;
};

arduinoGenerator.forBlock['math_number'] = function (block) {
    const code = Number(block.getFieldValue('NUM'));
    return [String(code), Order.ATOMIC];
};

arduinoGenerator.forBlock['math_base_parse_custom'] = function (block) {
    const base = parseInt(block.getFieldValue('BASE') || '10', 10);
    const raw = (block.getFieldValue('VALUE') || '0').trim();
    if (base === 10 && /^[-+]?\d+(\.\d+)?$/.test(raw)) {
        return [raw, Order.ATOMIC];
    }
    arduinoGenerator.addInclude('stdlib', '#include <stdlib.h>');
    const safe = escapeCppString(raw);
    return [`(long)strtol("${safe}", NULL, ${base})`, Order.ATOMIC];
};

arduinoGenerator.forBlock['math_arithmetic'] = function (block) {
    const op = block.getFieldValue('OP');
    const argument0 = arduinoGenerator.valueToCode(block, 'A', Order.ATOMIC) || '0';
    const argument1 = arduinoGenerator.valueToCode(block, 'B', Order.ATOMIC) || '0';

    if (op === 'POWER') {
        ensureMathHeader();
        return [`pow(${argument0}, ${argument1})`, Order.ATOMIC];
    }

    const OPERATORS: Record<string, string> = {
        'ADD': '+',
        'MINUS': '-',
        'MULTIPLY': '*',
        'DIVIDE': '/',
    };
    const operator = OPERATORS[op] || '+';
    return [`(${argument0} ${operator} ${argument1})`, Order.ATOMIC];
};

arduinoGenerator.forBlock['math_single'] = function (block) {
    const op = block.getFieldValue('OP');
    const num = arduinoGenerator.valueToCode(block, 'NUM', Order.ATOMIC) || '0';
    switch (op) {
        case 'ROOT':
            ensureMathHeader();
            return [`sqrt(${num})`, Order.ATOMIC];
        case 'ABS':
            return [`abs(${num})`, Order.ATOMIC];
        case 'NEG':
            return [`(-(${num}))`, Order.ATOMIC];
        case 'LN':
            ensureMathHeader();
            return [`log(${num})`, Order.ATOMIC];
        case 'LOG10':
            ensureMathHeader();
            return [`log10(${num})`, Order.ATOMIC];
        case 'EXP':
            ensureMathHeader();
            return [`exp(${num})`, Order.ATOMIC];
        case 'POW10':
            ensureMathHeader();
            return [`pow(10, ${num})`, Order.ATOMIC];
        default:
            return [num, Order.ATOMIC];
    }
};

arduinoGenerator.forBlock['math_trig'] = function (block) {
    const op = block.getFieldValue('OP');
    const num = arduinoGenerator.valueToCode(block, 'NUM', Order.ATOMIC) || '0';
    ensureMathHeader();
    switch (op) {
        case 'SIN':
            return [`sin((${num}) * PI / 180.0)`, Order.ATOMIC];
        case 'COS':
            return [`cos((${num}) * PI / 180.0)`, Order.ATOMIC];
        case 'TAN':
            return [`tan((${num}) * PI / 180.0)`, Order.ATOMIC];
        case 'ASIN':
            return [`(asin(${num}) * 180.0 / PI)`, Order.ATOMIC];
        case 'ACOS':
            return [`(acos(${num}) * 180.0 / PI)`, Order.ATOMIC];
        case 'ATAN':
            return [`(atan(${num}) * 180.0 / PI)`, Order.ATOMIC];
        default:
            return [num, Order.ATOMIC];
    }
};

arduinoGenerator.forBlock['math_round'] = function (block) {
    const op = block.getFieldValue('OP');
    const num = arduinoGenerator.valueToCode(block, 'NUM', Order.ATOMIC) || '0';
    ensureMathHeader();
    switch (op) {
        case 'ROUNDUP':
            return [`ceil(${num})`, Order.ATOMIC];
        case 'ROUNDDOWN':
            return [`floor(${num})`, Order.ATOMIC];
        default:
            return [`round(${num})`, Order.ATOMIC];
    }
};

arduinoGenerator.forBlock['math_atan2'] = function (block) {
    const x = arduinoGenerator.valueToCode(block, 'X', Order.ATOMIC) || '1';
    const y = arduinoGenerator.valueToCode(block, 'Y', Order.ATOMIC) || '1';
    ensureMathHeader();
    return [`(atan2(${y}, ${x}) * 180.0 / PI)`, Order.ATOMIC];
};

arduinoGenerator.forBlock['math_number_property'] = function (block) {
    const prop = block.getFieldValue('PROPERTY');
    const num = arduinoGenerator.valueToCode(block, 'NUMBER_TO_CHECK', Order.ATOMIC) || '0';
    switch (prop) {
        case 'EVEN':
            return [`((${num}) % 2 == 0)`, Order.ATOMIC];
        case 'ODD':
            return [`((${num}) % 2 != 0)`, Order.ATOMIC];
        case 'WHOLE':
            ensureMathHeader();
            return [`(floor(${num}) == (${num}))`, Order.ATOMIC];
        case 'POSITIVE':
            return [`((${num}) > 0)`, Order.ATOMIC];
        case 'NEGATIVE':
            return [`((${num}) < 0)`, Order.ATOMIC];
        case 'DIVISIBLE_BY': {
            const divisor = arduinoGenerator.valueToCode(block, 'DIVISOR', Order.ATOMIC) || '1';
            return [`((${num}) % (${divisor}) == 0)`, Order.ATOMIC];
        }
        case 'PRIME':
            arduinoGenerator.addDeclaration('ck_is_prime', `bool ck_is_prime(long n) {
  if (n <= 1) return false;
  if (n == 2) return true;
  if (n % 2 == 0) return false;
  for (long i = 3; i * i <= n; i += 2) {
    if (n % i == 0) return false;
  }
  return true;
}`);
            return [`ck_is_prime(${num})`, Order.ATOMIC];
        default:
            return ['false', Order.ATOMIC];
    }
};

arduinoGenerator.forBlock['math_round_to_custom'] = function (block) {
    const places = arduinoGenerator.valueToCode(block, 'PLACES', Order.ATOMIC) || '2';
    const num = arduinoGenerator.valueToCode(block, 'NUM', Order.ATOMIC) || '0';
    ensureMathHeader();
    arduinoGenerator.addDeclaration('ck_round_to', `double ck_round_to(double v, int places) {
  double scale = pow(10.0, places);
  return round(v * scale) / scale;
}`);
    return [`ck_round_to(${num}, ${places})`, Order.ATOMIC];
};

arduinoGenerator.forBlock['math_modulo'] = function (block) {
    const dividend = arduinoGenerator.valueToCode(block, 'DIVIDEND', Order.ATOMIC) || '0';
    const divisor = arduinoGenerator.valueToCode(block, 'DIVISOR', Order.ATOMIC) || '1';
    return [`(${dividend} % ${divisor})`, Order.ATOMIC];
};

arduinoGenerator.forBlock['math_constrain'] = function (block) {
    const value = arduinoGenerator.valueToCode(block, 'VALUE', Order.ATOMIC) || '0';
    const low = arduinoGenerator.valueToCode(block, 'LOW', Order.ATOMIC) || '0';
    const high = arduinoGenerator.valueToCode(block, 'HIGH', Order.ATOMIC) || '0';
    return [`constrain(${value}, ${low}, ${high})`, Order.ATOMIC];
};

arduinoGenerator.forBlock['math_random_int'] = function (block) {
    const from = arduinoGenerator.valueToCode(block, 'FROM', Order.ATOMIC) || '0';
    const to = arduinoGenerator.valueToCode(block, 'TO', Order.ATOMIC) || '100';
    return [`random(${from}, ${to} + 1)`, Order.ATOMIC];
};

arduinoGenerator.forBlock['math_random_float'] = function (_block) {
    return ['(random(0, 10000) / 10000.0)', Order.ATOMIC];
};

arduinoGenerator.forBlock['math_constant'] = function (block) {
    const constant = block.getFieldValue('CONSTANT');
    const CONSTANTS: Record<string, string> = {
        'PI': 'PI',
        'E': '2.718281828459045',
        'GOLDEN_RATIO': '1.61803398875',
        'SQRT2': '1.41421356237',
        'SQRT1_2': '0.70710678118',
        'INFINITY': 'INFINITY',
    };
    return [CONSTANTS[constant] || '0', Order.ATOMIC];
};

arduinoGenerator.forBlock['math_map_custom'] = function (block) {
    const value = arduinoGenerator.valueToCode(block, 'VALUE', Order.ATOMIC) || '0';
    const fromLow = arduinoGenerator.valueToCode(block, 'FROM_LOW', Order.ATOMIC) || '0';
    const fromHigh = arduinoGenerator.valueToCode(block, 'FROM_HIGH', Order.ATOMIC) || '1023';
    const toLow = arduinoGenerator.valueToCode(block, 'TO_LOW', Order.ATOMIC) || '0';
    const toHigh = arduinoGenerator.valueToCode(block, 'TO_HIGH', Order.ATOMIC) || '255';
    return [
        `map(${value}, ${fromLow}, ${fromHigh}, ${toLow}, ${toHigh})`,
        Order.ATOMIC,
    ];
};

arduinoGenerator.forBlock['math_minmax_custom'] = function (block) {
    const op = block.getFieldValue('OP');
    const a = arduinoGenerator.valueToCode(block, 'A', Order.ATOMIC) || '0';
    const b = arduinoGenerator.valueToCode(block, 'B', Order.ATOMIC) || '0';
    if (op === 'MAX') {
        return [`((${a}) > (${b}) ? (${a}) : (${b}))`, Order.ATOMIC];
    }
    return [`((${a}) < (${b}) ? (${a}) : (${b}))`, Order.ATOMIC];
};

arduinoGenerator.forBlock['math_bitwise_not_custom'] = function (block) {
    const num = arduinoGenerator.valueToCode(block, 'NUM', Order.ATOMIC) || '0';
    return [`(~(${num}))`, Order.ATOMIC];
};

arduinoGenerator.forBlock['math_bitwise_op_custom'] = function (block) {
    const op = block.getFieldValue('OP') || 'AND';
    const a = arduinoGenerator.valueToCode(block, 'A', Order.ATOMIC) || '0';
    const b = arduinoGenerator.valueToCode(block, 'B', Order.ATOMIC) || '0';
    switch (op) {
        case 'SHL':
            return [`((${a}) << (${b}))`, Order.ATOMIC];
        case 'SHR':
            return [`((${a}) >> (${b}))`, Order.ATOMIC];
        case 'OR':
            return [`((${a}) | (${b}))`, Order.ATOMIC];
        case 'XOR':
            return [`((${a}) ^ (${b}))`, Order.ATOMIC];
        default:
            return [`((${a}) & (${b}))`, Order.ATOMIC];
    }
};

arduinoGenerator.forBlock['math_highlow_byte_custom'] = function (block) {
    const part = block.getFieldValue('PART') || 'HIGH';
    const num = arduinoGenerator.valueToCode(block, 'NUM', Order.ATOMIC) || '0';
    if (part === 'LOW') {
        return [`lowByte(${num})`, Order.ATOMIC];
    }
    return [`highByte(${num})`, Order.ATOMIC];
};

arduinoGenerator.forBlock['math_combine_word_custom'] = function (block) {
    const high = arduinoGenerator.valueToCode(block, 'HIGH', Order.ATOMIC) || '0';
    const low = arduinoGenerator.valueToCode(block, 'LOW', Order.ATOMIC) || '0';
    return [`word(${high}, ${low})`, Order.ATOMIC];
};

arduinoGenerator.forBlock['math_bit_read_custom'] = function (block) {
    const num = arduinoGenerator.valueToCode(block, 'NUM', Order.ATOMIC) || '0';
    const bit = arduinoGenerator.valueToCode(block, 'BIT', Order.ATOMIC) || '0';
    return [`bitRead(${num}, ${bit})`, Order.ATOMIC];
};

arduinoGenerator.forBlock['math_bit_write_custom'] = function (block) {
    const num = arduinoGenerator.valueToCode(block, 'NUM', Order.ATOMIC) || '0';
    const bit = arduinoGenerator.valueToCode(block, 'BIT', Order.ATOMIC) || '0';
    const value = arduinoGenerator.valueToCode(block, 'VALUE', Order.ATOMIC) || '0';
    return [
        `(((${num}) & ~(1UL << (${bit}))) | (((${value}) & 1UL) << (${bit})))`,
        Order.ATOMIC,
    ];
};

arduinoGenerator.forBlock['math_bit_set_custom'] = function (block) {
    const num = arduinoGenerator.valueToCode(block, 'NUM', Order.ATOMIC) || '0';
    const bit = arduinoGenerator.valueToCode(block, 'BIT', Order.ATOMIC) || '0';
    return [`((${num}) | (1UL << (${bit})))`, Order.ATOMIC];
};

arduinoGenerator.forBlock['math_bit_clear_custom'] = function (block) {
    const num = arduinoGenerator.valueToCode(block, 'NUM', Order.ATOMIC) || '0';
    const bit = arduinoGenerator.valueToCode(block, 'BIT', Order.ATOMIC) || '0';
    return [`((${num}) & ~(1UL << (${bit})))`, Order.ATOMIC];
};

arduinoGenerator.forBlock['math_change'] = function (block) {
    const argument0 = arduinoGenerator.valueToCode(block, 'DELTA', Order.ATOMIC) || '0';
    const varName = block.getField('VAR')?.getText() || 'item';

    // Ensure globally defined
    // @ts-ignore
    if (!arduinoGenerator.definitions_[varName]) {
        // @ts-ignore
        arduinoGenerator.definitions_[varName] = `int ${varName} = 0;`;
    }

    return `  ${varName} += ${argument0};\n`;
};

arduinoGenerator.forBlock['var_ref_custom'] = function (block) {
    const rawName = resolveVariableFieldName(block, 'NAME', 'variable');
    const varName = sanitizeVariableName(rawName);
    return [varName, Order.ATOMIC];
};

arduinoGenerator.forBlock['macro_define_custom'] = function (block) {
    const rawName = String(block.getFieldValue('NAME') || 'LED_PIN').trim();
    const name = sanitizeIdentifier(rawName || 'LED_PIN');
    const value = String(block.getFieldValue('VALUE') ?? '').trim();
    const directive = value ? `#define ${name} ${value}` : `#define ${name}`;
    arduinoGenerator.addMacro(`macro_${name}`, directive);
    return '';
};

arduinoGenerator.forBlock['code_include_custom'] = function (block) {
    const style = String(block.getFieldValue('STYLE') || 'ANGLE').trim();
    const rawHeader = String(block.getFieldValue('HEADER') || 'Wire.h')
        .trim()
        .replace(/^["<]+|[">]+$/g, '')
        .replace(/[\r\n]/g, '');
    if (!rawHeader) return '';
    const directive = style === 'QUOTE' ? `#include "${rawHeader}"` : `#include <${rawHeader}>`;
    arduinoGenerator.addInclude(`user_inc_${sanitizeIdentifier(rawHeader)}`, directive);
    return '';
};

arduinoGenerator.forBlock['code_comment_custom'] = function (block) {
    const text = String(block.getFieldValue('TEXT') || '').replace(/[\r\n]+/g, ' ').trim();
    return text ? `  // ${text}\n` : '  //\n';
};

arduinoGenerator.forBlock['var_declare_custom'] = function (block) {
    const scope = block.getFieldValue('SCOPE') || 'GLOBAL';
    const qual = block.getFieldValue('QUAL') || 'NONE';
    const rawName = resolveVariableFieldName(block, 'NAME', 'variable');
    const varName = sanitizeVariableName(rawName);
    const typeName = block.getFieldValue('TYPE') || 'int';
    const initValueRaw = (arduinoGenerator.valueToCode(block, 'VALUE', Order.ATOMIC) || '').trim();
    const initValue = normalizeInitializerByType(typeName, initValueRaw);
    // Keep migration-friendly behavior: declarations always get a default init when VALUE is empty.
    const initializerValue = initValue || defaultValueForType(typeName);
    const initializer = initializerValue ? ` = ${initializerValue}` : '';
    const prefix = qualifierPrefix(qual);
    const declaration = `${prefix}${typeName} ${varName}${initializer};`;

    if (scope === 'GLOBAL') {
        arduinoGenerator.addDeclaration(`var_global_${varName}`, declaration);
        return '';
    }
    return `  ${declaration}\n`;
};

arduinoGenerator.forBlock['variables_declare'] = function (block) {
    const scopeRaw = String(block.getFieldValue('variables_type') || 'global_variate').toLowerCase();
    const scope = scopeRaw.includes('global') ? 'GLOBAL' : 'LOCAL';
    const rawName = resolveVariableFieldName(block, 'VAR', 'item');
    const varName = sanitizeVariableName(rawName);
    const typeName = block.getFieldValue('TYPE') || 'int';
    const initValueRaw = (arduinoGenerator.valueToCode(block, 'VALUE', Order.ATOMIC) || '').trim();
    const initValue = normalizeInitializerByType(typeName, initValueRaw);
    const initializerValue = initValue || defaultValueForType(typeName);
    const initializer = initializerValue ? ` = ${initializerValue}` : '';
    const declaration = `${typeName} ${varName}${initializer};`;

    if (scope === 'GLOBAL') {
        arduinoGenerator.addDeclaration(`var_global_${varName}`, declaration);
        return '';
    }
    return `  ${declaration}\n`;
};

arduinoGenerator.forBlock['var_set_custom'] = function (block) {
    const lhsExpr = resolveLValueFromInputOrField(block, 'NAME', 'NAME', 'variable');
    const value = arduinoGenerator.valueToCode(block, 'VALUE', Order.ATOMIC) || '0';
    return `  ${lhsExpr} = ${value};\n`;
};

arduinoGenerator.forBlock['var_cast_custom'] = function (block) {
    const typeName = block.getFieldValue('TYPE') || 'int';
    const value = arduinoGenerator.valueToCode(block, 'VALUE', Order.ATOMIC) || '0';
    return [`((${typeName})(${value}))`, Order.ATOMIC];
};

arduinoGenerator.forBlock['var_dynamic_alloc_custom'] = function (block) {
    arduinoGenerator.addInclude('stdlib', '#include <stdlib.h>');
    const scope = block.getFieldValue('SCOPE') || 'GLOBAL';
    const rawName = resolveVariableFieldName(block, 'NAME', 'buffer');
    const varName = sanitizeVariableName(rawName);
    const typeName = block.getFieldValue('TYPE') || 'int';
    const count = arduinoGenerator.valueToCode(block, 'COUNT', Order.ATOMIC) || '1';
    const declaration = `${typeName}* ${varName} = (${typeName}*)malloc(sizeof(${typeName}) * (${count}));`;

    if (scope === 'GLOBAL') {
        arduinoGenerator.addDeclaration(`var_global_dyn_${varName}`, declaration);
        return '';
    }
    return `  ${declaration}\n`;
};

arduinoGenerator.forBlock['var_dynamic_free_custom'] = function (block) {
    arduinoGenerator.addInclude('stdlib', '#include <stdlib.h>');
    const ptrExpr = resolveLValueFromInputOrField(block, 'NAME', 'NAME', 'buffer');
    return `  if (${ptrExpr} != NULL) {\n    free(${ptrExpr});\n    ${ptrExpr} = NULL;\n  }\n`;
};

arduinoGenerator.forBlock['array_declare_1d_custom'] = function (block) {
    const scope = block.getFieldValue('SCOPE') || 'GLOBAL';
    const rawName = block.getFieldValue('NAME') || 'arr1';
    const name = sanitizeVariableName(rawName);
    const typeName = block.getFieldValue('TYPE') || 'int';
    const itemCount = Math.max(0, Number((block as any).itemCount_ || 0));
    const lenExprRaw = (arduinoGenerator.valueToCode(block, 'LEN', Order.ATOMIC) || String(Math.max(1, itemCount))).trim();
    let lenExpr = lenExprRaw;
    const normalizedLen = lenExprRaw.replace(/^\((.*)\)$/, '$1').trim();
    if (/^\d+$/.test(normalizedLen)) {
        const parsedLen = parseInt(normalizedLen, 10);
        lenExpr = String(Math.max(1, parsedLen, itemCount));
    }
    const defaultVal = defaultValueForType(typeName);
    const values: string[] = [];
    for (let i = 0; i < itemCount; i++) {
        const v = (arduinoGenerator.valueToCode(block, `VALUE${i}`, Order.ATOMIC) || defaultVal).trim();
        values.push(normalizeArrayValueByType(typeName, v || defaultVal));
    }
    const init = values.length > 0 ? `{ ${values.join(', ')} }` : `{ ${defaultVal} }`;
    const declaration = `${typeName} ${name}[${lenExpr}] = ${init};`;
    if (scope === 'GLOBAL') {
        arduinoGenerator.addDeclaration(`arr1d_${name}`, declaration);
        return '';
    }
    return `  ${declaration}\n`;
};

arduinoGenerator.forBlock['array_declare_1d_empty_custom'] = function (block) {
    const scope = block.getFieldValue('SCOPE') || 'GLOBAL';
    const rawName = block.getFieldValue('NAME') || 'arr1';
    const name = sanitizeVariableName(rawName);
    const typeName = block.getFieldValue('TYPE') || 'int';
    const lenExpr = (arduinoGenerator.valueToCode(block, 'LEN', Order.ATOMIC) || '1').trim();
    const declaration = `${typeName} ${name}[${lenExpr}];`;
    if (scope === 'GLOBAL') {
        arduinoGenerator.addDeclaration(`arr1d_${name}`, declaration);
        return '';
    }
    return `  ${declaration}\n`;
};

arduinoGenerator.forBlock['array_declare_2d_custom'] = function (block) {
    const scope = block.getFieldValue('SCOPE') || 'GLOBAL';
    const rawName = block.getFieldValue('NAME') || 'arr2';
    const name = sanitizeVariableName(rawName);
    const typeName = block.getFieldValue('TYPE') || 'int';
    const rows = Math.max(1, parseInt(block.getFieldValue('ROWS') || '2', 10) || 2);
    const cols = Math.max(1, parseInt(block.getFieldValue('COLS') || '2', 10) || 2);
    const declaration = `${typeName} ${name}[${rows}][${cols}] = {0};`;
    if (scope === 'GLOBAL') {
        arduinoGenerator.addDeclaration(`arr2d_${name}`, declaration);
        return '';
    }
    return `  ${declaration}\n`;
};

arduinoGenerator.forBlock['array_row_literal_custom'] = function (block) {
    let typeName = 'int';
    const parent: any = typeof block.getParent === 'function' ? block.getParent() : null;
    if (parent && parent.type === 'array_declare_2d_init_custom') {
        typeName = parent.getFieldValue('TYPE') || 'int';
    }
    const itemCount = Math.max(0, Number((block as any).itemCount_ || 0));
    const defaultVal = defaultValueForType(typeName);
    const values: string[] = [];
    for (let i = 0; i < itemCount; i++) {
        const raw = (arduinoGenerator.valueToCode(block, `VALUE${i}`, Order.ATOMIC) || defaultVal).trim();
        values.push(normalizeArrayValueByType(typeName, raw || defaultVal));
    }
    const init = values.length > 0 ? `{ ${values.join(', ')} }` : `{ ${defaultVal} }`;
    return [init, Order.ATOMIC];
};

arduinoGenerator.forBlock['array_declare_2d_init_custom'] = function (block) {
    const scope = block.getFieldValue('SCOPE') || 'GLOBAL';
    const rawName = block.getFieldValue('NAME') || 'arr2';
    const name = sanitizeVariableName(rawName);
    const typeName = block.getFieldValue('TYPE') || 'int';
    const rowCount = Math.max(0, Number((block as any).itemCount_ || 0));
    const rowsExprRaw = (arduinoGenerator.valueToCode(block, 'ROWS', Order.ATOMIC) || String(Math.max(1, rowCount))).trim();
    const colsExprRaw = (arduinoGenerator.valueToCode(block, 'COLS', Order.ATOMIC) || '3').trim();
    let maxRowLiteralCols = 0;
    for (let i = 0; i < rowCount; i++) {
        const rowBlock: any = typeof block.getInputTargetBlock === 'function' ? block.getInputTargetBlock(`ROW${i}`) : null;
        if (rowBlock && rowBlock.type === 'array_row_literal_custom') {
            maxRowLiteralCols = Math.max(maxRowLiteralCols, Math.max(1, Number(rowBlock.itemCount_ || 0)));
        }
    }
    let rowsExpr = rowsExprRaw;
    let colsExpr = colsExprRaw;
    const normalizedRows = rowsExprRaw.replace(/^\((.*)\)$/, '$1').trim();
    const normalizedCols = colsExprRaw.replace(/^\((.*)\)$/, '$1').trim();
    if (/^\d+$/.test(normalizedRows)) {
        const parsed = parseInt(normalizedRows, 10);
        rowsExpr = String(Math.max(1, parsed, rowCount));
    }
    if (/^\d+$/.test(normalizedCols)) {
        const parsed = parseInt(normalizedCols, 10);
        colsExpr = String(Math.max(1, parsed, maxRowLiteralCols));
    }

    const defaultVal = defaultValueForType(typeName);
    const defaultCols = /^\d+$/.test(colsExpr) ? Math.max(1, parseInt(colsExpr, 10)) : Math.max(1, maxRowLiteralCols || 1);
    const defaultRow = `{ ${new Array(defaultCols).fill(normalizeArrayValueByType(typeName, defaultVal)).join(', ')} }`;
    const rows: string[] = [];
    for (let i = 0; i < rowCount; i++) {
        const rowCode = (arduinoGenerator.valueToCode(block, `ROW${i}`, Order.ATOMIC) || '').trim();
        rows.push(rowCode || defaultRow);
    }
    const init = rows.length > 0 ? `{ ${rows.join(', ')} }` : `{ { ${normalizeArrayValueByType(typeName, defaultVal)} } }`;
    const declaration = `${typeName} ${name}[${rowsExpr}][${colsExpr}] = ${init};`;
    if (scope === 'GLOBAL') {
        arduinoGenerator.addDeclaration(`arr2d_${name}`, declaration);
        return '';
    }
    return `  ${declaration}\n`;
};

arduinoGenerator.forBlock['array_declare_3d_custom'] = function (block) {
    const scope = block.getFieldValue('SCOPE') || 'GLOBAL';
    const rawName = block.getFieldValue('NAME') || 'arr3';
    const name = sanitizeVariableName(rawName);
    const typeName = block.getFieldValue('TYPE') || 'int';
    const d1 = Math.max(1, parseInt(block.getFieldValue('D1') || '2', 10) || 2);
    const d2 = Math.max(1, parseInt(block.getFieldValue('D2') || '2', 10) || 2);
    const d3 = Math.max(1, parseInt(block.getFieldValue('D3') || '2', 10) || 2);
    const declaration = `${typeName} ${name}[${d1}][${d2}][${d3}] = {0};`;
    if (scope === 'GLOBAL') {
        arduinoGenerator.addDeclaration(`arr3d_${name}`, declaration);
        return '';
    }
    return `  ${declaration}\n`;
};

arduinoGenerator.forBlock['array_declare_nd_custom'] = function (block) {
    const scope = block.getFieldValue('SCOPE') || 'GLOBAL';
    const rawName = block.getFieldValue('NAME') || 'arrN';
    const name = sanitizeVariableName(rawName);
    const typeName = block.getFieldValue('TYPE') || 'int';
    const dimCount = Math.max(2, Number((block as any).dimCount_ || 2));
    const dims: number[] = [];
    for (let i = 0; i < dimCount; i++) {
        const d = Math.max(1, parseInt(block.getFieldValue(`DIMVAL${i}`) || '2', 10) || 2);
        dims.push(d);
    }
    const suffix = dims.map((d) => `[${d}]`).join('');
    const declaration = `${typeName} ${name}${suffix} = {0};`;
    if (scope === 'GLOBAL') {
        arduinoGenerator.addDeclaration(`arrnd_${name}`, declaration);
        return '';
    }
    return `  ${declaration}\n`;
};

arduinoGenerator.forBlock['array_get_1d_custom'] = function (block) {
    const rawName = block.getFieldValue('NAME') || 'arr1';
    const name = sanitizeVariableName(rawName);
    const idx = arduinoGenerator.valueToCode(block, 'IDX', Order.ATOMIC) || '0';
    return [`${name}[${idx}]`, Order.ATOMIC];
};

arduinoGenerator.forBlock['array_length_1d_custom'] = function (block) {
    const rawName = block.getFieldValue('NAME') || 'arr1';
    const name = sanitizeVariableName(rawName);
    return [`(sizeof(${name}) / sizeof(${name}[0]))`, Order.ATOMIC];
};

arduinoGenerator.forBlock['array_set_1d_custom'] = function (block) {
    const rawName = block.getFieldValue('NAME') || 'arr1';
    const name = sanitizeVariableName(rawName);
    const idx = arduinoGenerator.valueToCode(block, 'IDX', Order.ATOMIC) || '0';
    const value = arduinoGenerator.valueToCode(block, 'VALUE', Order.ATOMIC) || '0';
    return `  ${name}[${idx}] = ${value};\n`;
};

arduinoGenerator.forBlock['array_push_1d_custom'] = function (block) {
    const rawName = block.getFieldValue('NAME') || 'arr1';
    const name = sanitizeVariableName(rawName);
    const lenVar = sanitizeVariableName(block.getFieldValue('LEN_VAR') || 'arr1_len');
    ensureArray1dRuntimeContext(name, lenVar);
    ensureArrayCrudHelpers();
    const value = (arduinoGenerator.valueToCode(block, 'VALUE', Order.ATOMIC) || '0').trim();
    return `  ck_array_push(${name}, ${lenVar}, ${value});\n`;
};

arduinoGenerator.forBlock['array_insert_1d_custom'] = function (block) {
    const rawName = block.getFieldValue('NAME') || 'arr1';
    const name = sanitizeVariableName(rawName);
    const lenVar = sanitizeVariableName(block.getFieldValue('LEN_VAR') || 'arr1_len');
    ensureArray1dRuntimeContext(name, lenVar);
    ensureArrayCrudHelpers();
    const idx = (arduinoGenerator.valueToCode(block, 'IDX', Order.ATOMIC) || '0').trim();
    const value = (arduinoGenerator.valueToCode(block, 'VALUE', Order.ATOMIC) || '0').trim();
    return `  ck_array_insert(${name}, ${lenVar}, ${idx}, ${value});\n`;
};

arduinoGenerator.forBlock['array_remove_1d_custom'] = function (block) {
    const rawName = block.getFieldValue('NAME') || 'arr1';
    const name = sanitizeVariableName(rawName);
    const lenVar = sanitizeVariableName(block.getFieldValue('LEN_VAR') || 'arr1_len');
    ensureArray1dRuntimeContext(name, lenVar);
    ensureArrayCrudHelpers();
    const idx = (arduinoGenerator.valueToCode(block, 'IDX', Order.ATOMIC) || '0').trim();
    return `  ck_array_remove(${name}, ${lenVar}, ${idx});\n`;
};

arduinoGenerator.forBlock['array_clear_1d_custom'] = function (block) {
    const lenVar = sanitizeVariableName(block.getFieldValue('LEN_VAR') || 'arr1_len');
    if (!hasDeclaredSymbol(lenVar)) {
        arduinoGenerator.addDeclaration(`arr1d_len_${lenVar}`, `int ${lenVar} = 0;`);
    }
    return `  ${lenVar} = 0;\n`;
};

arduinoGenerator.forBlock['array_find_1d_custom'] = function (block) {
    const rawName = block.getFieldValue('NAME') || 'arr1';
    const name = sanitizeVariableName(rawName);
    const lenVar = sanitizeVariableName(block.getFieldValue('LEN_VAR') || 'arr1_len');
    ensureArray1dRuntimeContext(name, lenVar);
    ensureArrayCrudHelpers();
    const value = (arduinoGenerator.valueToCode(block, 'VALUE', Order.ATOMIC) || '0').trim();
    return [`ck_array_find(${name}, ${lenVar}, ${value})`, Order.ATOMIC];
};

arduinoGenerator.forBlock['array_contains_1d_custom'] = function (block) {
    const rawName = block.getFieldValue('NAME') || 'arr1';
    const name = sanitizeVariableName(rawName);
    const lenVar = sanitizeVariableName(block.getFieldValue('LEN_VAR') || 'arr1_len');
    ensureArray1dRuntimeContext(name, lenVar);
    ensureArrayCrudHelpers();
    const value = (arduinoGenerator.valueToCode(block, 'VALUE', Order.ATOMIC) || '0').trim();
    return [`(ck_array_find(${name}, ${lenVar}, ${value}) >= 0)`, Order.ATOMIC];
};

arduinoGenerator.forBlock['array_sort_1d_custom'] = function (block) {
    const rawName = block.getFieldValue('NAME') || 'arr1';
    const name = sanitizeVariableName(rawName);
    const lenVar = sanitizeVariableName(block.getFieldValue('LEN_VAR') || 'arr1_len');
    const order = block.getFieldValue('ORDER') || 'ASC';
    ensureArray1dRuntimeContext(name, lenVar);
    ensureArrayAlgoHelpers();
    const isDesc = order === 'DESC' ? 'true' : 'false';
    return `  ck_array_sort(${name}, ${lenVar}, ${isDesc});\n`;
};

arduinoGenerator.forBlock['array_reverse_1d_custom'] = function (block) {
    const rawName = block.getFieldValue('NAME') || 'arr1';
    const name = sanitizeVariableName(rawName);
    const lenVar = sanitizeVariableName(block.getFieldValue('LEN_VAR') || 'arr1_len');
    ensureArray1dRuntimeContext(name, lenVar);
    ensureArrayAlgoHelpers();
    return `  ck_array_reverse(${name}, ${lenVar});\n`;
};

arduinoGenerator.forBlock['array_fill_1d_custom'] = function (block) {
    const rawName = block.getFieldValue('NAME') || 'arr1';
    const name = sanitizeVariableName(rawName);
    const lenVar = sanitizeVariableName(block.getFieldValue('LEN_VAR') || 'arr1_len');
    const value = (arduinoGenerator.valueToCode(block, 'VALUE', Order.ATOMIC) || '0').trim();
    ensureArray1dRuntimeContext(name, lenVar);
    ensureArrayAlgoHelpers();
    return `  ck_array_fill(${name}, ${lenVar}, ${value});\n`;
};

arduinoGenerator.forBlock['array_copy_1d_custom'] = function (block) {
    const srcName = sanitizeVariableName(block.getFieldValue('SRC_NAME') || 'arr1');
    const dstName = sanitizeVariableName(block.getFieldValue('DST_NAME') || 'copyList');
    const srcLenVar = sanitizeVariableName(block.getFieldValue('SRC_LEN_VAR') || 'arr1_len');
    const dstLenVar = sanitizeVariableName(block.getFieldValue('DST_LEN_VAR') || 'copyList_len');
    ensureArray1dRuntimeContext(srcName, srcLenVar);
    ensureArray1dRuntimeContext(dstName, dstLenVar);
    ensureArrayAlgoHelpers();
    return `  ${dstLenVar} = ck_array_copy(${dstName}, ${srcName}, ${srcLenVar});\n`;
};

arduinoGenerator.forBlock['array_rotate_1d_custom'] = function (block) {
    const rawName = block.getFieldValue('NAME') || 'arr1';
    const name = sanitizeVariableName(rawName);
    const lenVar = sanitizeVariableName(block.getFieldValue('LEN_VAR') || 'arr1_len');
    const dir = block.getFieldValue('DIR') || 'LEFT';
    const step = (arduinoGenerator.valueToCode(block, 'STEP', Order.ATOMIC) || '1').trim();
    ensureArray1dRuntimeContext(name, lenVar);
    ensureArrayAlgoHelpers();
    const right = dir === 'RIGHT' ? 'true' : 'false';
    return `  ck_array_rotate(${name}, ${lenVar}, ${step}, ${right});\n`;
};

arduinoGenerator.forBlock['array_get_2d_custom'] = function (block) {
    const rawName = block.getFieldValue('NAME') || 'arr2';
    const name = sanitizeVariableName(rawName);
    const i = arduinoGenerator.valueToCode(block, 'I', Order.ATOMIC) || '0';
    const j = arduinoGenerator.valueToCode(block, 'J', Order.ATOMIC) || '0';
    return [`${name}[${i}][${j}]`, Order.ATOMIC];
};

arduinoGenerator.forBlock['array_set_2d_custom'] = function (block) {
    const rawName = block.getFieldValue('NAME') || 'arr2';
    const name = sanitizeVariableName(rawName);
    const i = arduinoGenerator.valueToCode(block, 'I', Order.ATOMIC) || '0';
    const j = arduinoGenerator.valueToCode(block, 'J', Order.ATOMIC) || '0';
    const value = arduinoGenerator.valueToCode(block, 'VALUE', Order.ATOMIC) || '0';
    return `  ${name}[${i}][${j}] = ${value};\n`;
};

arduinoGenerator.forBlock['array_push_row_2d_custom'] = function (block) {
    const rawName = block.getFieldValue('NAME') || 'arr2';
    const name = sanitizeVariableName(rawName);
    const rowsVar = sanitizeVariableName(block.getFieldValue('ROWS_VAR') || 'arr2_rows');
    ensureArray2dRuntimeContext(name, rowsVar);
    const rowBlock: any = typeof block.getInputTargetBlock === 'function' ? block.getInputTargetBlock('VALUE') : null;
    if (rowBlock && rowBlock.type === 'array_row_literal_custom') {
        const sid = sanitizeIdentifier(block.id || `${name}_push_row`);
        const maxRowsVar = `ck_max_rows_${sid}`;
        const colsVar = `ck_cols_${sid}`;
        const rowVar = `ck_row_${sid}`;
        const values = collectRowLiteralValues(rowBlock);
        const assignments = values
            .map((v, i) => `      if (${i} < ${colsVar}) ${name}[${rowVar}][${i}] = ${v};`)
            .join('\n');
        return `  {
    int ${maxRowsVar} = (int)(sizeof(${name}) / sizeof(${name}[0]));
    int ${colsVar} = (int)(sizeof(${name}[0]) / sizeof(${name}[0][0]));
    if (${rowsVar} < 0) ${rowsVar} = 0;
    if (${rowsVar} < ${maxRowsVar}) {
      int ${rowVar} = ${rowsVar};
      for (int c = 0; c < ${colsVar}; ++c) {
        ${name}[${rowVar}][c] = decltype(${name}[0][0])();
      }
${assignments ? `${assignments}\n` : ''}      ${rowsVar}++;
    }
  }
`;
    }
    ensureArray2dCrudHelpers();
    const value = (arduinoGenerator.valueToCode(block, 'VALUE', Order.ATOMIC) || '0').trim();
    return `  ck_array2d_push_row_fill(${name}, ${rowsVar}, ${value});\n`;
};

arduinoGenerator.forBlock['array_insert_row_2d_custom'] = function (block) {
    const rawName = block.getFieldValue('NAME') || 'arr2';
    const name = sanitizeVariableName(rawName);
    const rowsVar = sanitizeVariableName(block.getFieldValue('ROWS_VAR') || 'arr2_rows');
    ensureArray2dRuntimeContext(name, rowsVar);
    const rowIdx = (arduinoGenerator.valueToCode(block, 'ROW_IDX', Order.ATOMIC) || '0').trim();
    const rowBlock: any = typeof block.getInputTargetBlock === 'function' ? block.getInputTargetBlock('VALUE') : null;
    if (rowBlock && rowBlock.type === 'array_row_literal_custom') {
        const sid = sanitizeIdentifier(block.id || `${name}_insert_row`);
        const maxRowsVar = `ck_max_rows_${sid}`;
        const colsVar = `ck_cols_${sid}`;
        const rowVar = `ck_row_${sid}`;
        const idxVar = `ck_idx_${sid}`;
        const values = collectRowLiteralValues(rowBlock);
        const assignments = values
            .map((v, i) => `      if (${i} < ${colsVar}) ${name}[${rowVar}][${i}] = ${v};`)
            .join('\n');
        return `  {
    int ${maxRowsVar} = (int)(sizeof(${name}) / sizeof(${name}[0]));
    int ${colsVar} = (int)(sizeof(${name}[0]) / sizeof(${name}[0][0]));
    int ${idxVar} = ${rowIdx};
    if (${rowsVar} < 0) ${rowsVar} = 0;
    if (${rowsVar} < ${maxRowsVar}) {
      if (${idxVar} < 0) ${idxVar} = 0;
      if (${idxVar} > ${rowsVar}) ${idxVar} = ${rowsVar};
      for (int r = ${rowsVar}; r > ${idxVar}; --r) {
        for (int c = 0; c < ${colsVar}; ++c) {
          ${name}[r][c] = ${name}[r - 1][c];
        }
      }
      int ${rowVar} = ${idxVar};
      for (int c = 0; c < ${colsVar}; ++c) {
        ${name}[${rowVar}][c] = decltype(${name}[0][0])();
      }
${assignments ? `${assignments}\n` : ''}      ${rowsVar}++;
    }
  }
`;
    }
    ensureArray2dCrudHelpers();
    const value = (arduinoGenerator.valueToCode(block, 'VALUE', Order.ATOMIC) || '0').trim();
    return `  ck_array2d_insert_row_fill(${name}, ${rowsVar}, ${rowIdx}, ${value});\n`;
};

arduinoGenerator.forBlock['array_remove_row_2d_custom'] = function (block) {
    const rawName = block.getFieldValue('NAME') || 'arr2';
    const name = sanitizeVariableName(rawName);
    const rowsVar = sanitizeVariableName(block.getFieldValue('ROWS_VAR') || 'arr2_rows');
    ensureArray2dRuntimeContext(name, rowsVar);
    ensureArray2dCrudHelpers();
    const rowIdx = (arduinoGenerator.valueToCode(block, 'ROW_IDX', Order.ATOMIC) || '0').trim();
    return `  ck_array2d_remove_row(${name}, ${rowsVar}, ${rowIdx});\n`;
};

arduinoGenerator.forBlock['array_contains_2d_custom'] = function (block) {
    const rawName = block.getFieldValue('NAME') || 'arr2';
    const name = sanitizeVariableName(rawName);
    const rowsVar = sanitizeVariableName(block.getFieldValue('ROWS_VAR') || 'arr2_rows');
    ensureArray2dRuntimeContext(name, rowsVar);
    ensureArray2dCrudHelpers();
    const value = (arduinoGenerator.valueToCode(block, 'VALUE', Order.ATOMIC) || '0').trim();
    return [`ck_array2d_contains(${name}, ${rowsVar}, ${value})`, Order.ATOMIC];
};

arduinoGenerator.forBlock['array_find_2d_custom'] = function (block) {
    const rawName = block.getFieldValue('NAME') || 'arr2';
    const name = sanitizeVariableName(rawName);
    const rowsVar = sanitizeVariableName(block.getFieldValue('ROWS_VAR') || 'arr2_rows');
    ensureArray2dRuntimeContext(name, rowsVar);
    ensureArray2dCrudHelpers();
    const value = (arduinoGenerator.valueToCode(block, 'VALUE', Order.ATOMIC) || '0').trim();
    return [`ck_array2d_find_linear(${name}, ${rowsVar}, ${value})`, Order.ATOMIC];
};

arduinoGenerator.forBlock['array_get_3d_custom'] = function (block) {
    const rawName = block.getFieldValue('NAME') || 'arr3';
    const name = sanitizeVariableName(rawName);
    const i = arduinoGenerator.valueToCode(block, 'I', Order.ATOMIC) || '0';
    const j = arduinoGenerator.valueToCode(block, 'J', Order.ATOMIC) || '0';
    const k = arduinoGenerator.valueToCode(block, 'K', Order.ATOMIC) || '0';
    return [`${name}[${i}][${j}][${k}]`, Order.ATOMIC];
};

arduinoGenerator.forBlock['array_set_3d_custom'] = function (block) {
    const rawName = block.getFieldValue('NAME') || 'arr3';
    const name = sanitizeVariableName(rawName);
    const i = arduinoGenerator.valueToCode(block, 'I', Order.ATOMIC) || '0';
    const j = arduinoGenerator.valueToCode(block, 'J', Order.ATOMIC) || '0';
    const k = arduinoGenerator.valueToCode(block, 'K', Order.ATOMIC) || '0';
    const value = arduinoGenerator.valueToCode(block, 'VALUE', Order.ATOMIC) || '0';
    return `  ${name}[${i}][${j}][${k}] = ${value};\n`;
};

arduinoGenerator.forBlock['array_get_nd_custom'] = function (block) {
    const rawName = block.getFieldValue('NAME') || 'arrN';
    const name = sanitizeVariableName(rawName);
    const indexCount = Math.max(2, Number((block as any).indexCount_ || 2));
    let suffix = '';
    for (let i = 0; i < indexCount; i++) {
        const idx = arduinoGenerator.valueToCode(block, `IDX${i}`, Order.ATOMIC) || '0';
        suffix += `[${idx}]`;
    }
    return [`${name}${suffix}`, Order.ATOMIC];
};

arduinoGenerator.forBlock['array_set_nd_custom'] = function (block) {
    const rawName = block.getFieldValue('NAME') || 'arrN';
    const name = sanitizeVariableName(rawName);
    const indexCount = Math.max(2, Number((block as any).indexCount_ || 2));
    let suffix = '';
    for (let i = 0; i < indexCount; i++) {
        const idx = arduinoGenerator.valueToCode(block, `IDX${i}`, Order.ATOMIC) || '0';
        suffix += `[${idx}]`;
    }
    const value = arduinoGenerator.valueToCode(block, 'VALUE', Order.ATOMIC) || '0';
    return `  ${name}${suffix} = ${value};\n`;
};

arduinoGenerator.forBlock['math_incdec_custom'] = function (block) {
    const fromInput = (arduinoGenerator.valueToCode(block, 'VAR', Order.ATOMIC) || '').trim();
    const varName = block.getField('VAR')?.getText() || 'item';
    const target = fromInput || varName;
    const op = block.getFieldValue('OP') || 'POST_INC';

    // @ts-ignore
    if (!fromInput && !arduinoGenerator.definitions_[varName]) {
        // @ts-ignore
        arduinoGenerator.definitions_[varName] = `int ${varName} = 0;`;
    }

    switch (op) {
        case 'PRE_INC':
            return `  ++${target};\n`;
        case 'POST_DEC':
            return `  ${target}--;\n`;
        case 'PRE_DEC':
            return `  --${target};\n`;
        default:
            return `  ${target}++;\n`;
    }
};

arduinoGenerator.forBlock['math_auto_add_or_minus'] = function (block) {
    const target = resolveLValueFromInputOrField(
        block,
        'math_auto_add_minus_output',
        'VAR',
        'item'
    );
    const op = String(block.getFieldValue('math_auto_add_minus_type') || '++').trim();
    if (op === '--') {
        return `  ${target}--;\n`;
    }
    return `  ${target}++;\n`;
};

arduinoGenerator.forBlock['math_compound_assign_custom'] = function (block) {
    const fromInput = (arduinoGenerator.valueToCode(block, 'VAR', Order.ATOMIC) || '').trim();
    const target = fromInput || 'item';
    const op = block.getFieldValue('OP') || '+=';
    const value = arduinoGenerator.valueToCode(block, 'VALUE', Order.ATOMIC) || '0';

    // If no variable block plugged in, ensure fallback variable exists.
    // @ts-ignore
    if (!fromInput && !arduinoGenerator.definitions_['item']) {
        // @ts-ignore
        arduinoGenerator.definitions_['item'] = 'int item = 0;';
    }

    return `  ${target} ${op} ${value};\n`;
};

arduinoGenerator.forBlock['variables_get'] = function (block) {
    const varName = block.getField('VAR')?.getText() || 'item';
    // @ts-ignore
    if (!arduinoGenerator.definitions_[varName]) {
        // @ts-ignore
        arduinoGenerator.definitions_[varName] = `int ${varName} = 0;`;
    }
    return [varName, Order.ATOMIC];
};

arduinoGenerator.forBlock['variables_set'] = function (block) {
    const argument0 = arduinoGenerator.valueToCode(block, 'VALUE', Order.ATOMIC) || '0';
    const varName = block.getField('VAR')?.getText() || 'item';

    // @ts-ignore
    if (!arduinoGenerator.definitions_[varName]) {
        // @ts-ignore
        arduinoGenerator.definitions_[varName] = `int ${varName} = 0;`;
    }
    return `  ${varName} = ${argument0};\n`;
};

arduinoGenerator.forBlock['text_char_literal_custom'] = function (block) {
    const raw = block.getFieldValue('CHAR') || 'A';
    return [charLiteralFromField(raw), Order.ATOMIC];
};

arduinoGenerator.forBlock['text_char'] = function (block) {
    const raw = block.getFieldValue('TEXT') || block.getFieldValue('CHAR') || 'A';
    return [charLiteralFromField(raw), Order.ATOMIC];
};

arduinoGenerator.forBlock['text'] = function (block) {
    const textValue = block.getFieldValue('TEXT');
    const code = `"${escapeCppString(textValue)}"`;
    return [code, Order.ATOMIC];
};

arduinoGenerator.forBlock['value_to_text_custom'] = function (block) {
    const value = arduinoGenerator.valueToCode(block, 'VALUE', Order.ATOMIC) || '0';
    return [`String(${value})`, Order.ATOMIC];
};

arduinoGenerator.forBlock['text_concat_custom'] = function (block) {
    const a = arduinoGenerator.valueToCode(block, 'A', Order.ATOMIC) || '""';
    const b = arduinoGenerator.valueToCode(block, 'B', Order.ATOMIC) || '""';
    return [`(String(${a}) + String(${b}))`, Order.ATOMIC];
};

arduinoGenerator.forBlock['text_to_type_custom'] = function (block) {
    const value = arduinoGenerator.valueToCode(block, 'TEXT', Order.ATOMIC) || '""';
    const typeName = block.getFieldValue('TYPE') || 'int';
    const s = `String(${value})`;

    switch (typeName) {
        case 'String':
            return [s, Order.ATOMIC];
        case 'int':
            return [`((int)(${s}.toInt()))`, Order.ATOMIC];
        case 'long':
            return [`((long)(${s}.toInt()))`, Order.ATOMIC];
        case 'unsigned int':
            arduinoGenerator.addInclude('stdlib', '#include <stdlib.h>');
            return [`((unsigned int)strtoul((${s}).c_str(), NULL, 10))`, Order.ATOMIC];
        case 'unsigned long':
            arduinoGenerator.addInclude('stdlib', '#include <stdlib.h>');
            return [`((unsigned long)strtoul((${s}).c_str(), NULL, 10))`, Order.ATOMIC];
        case 'float':
            return [`((float)(${s}.toFloat()))`, Order.ATOMIC];
        case 'double':
            return [`((double)(${s}.toFloat()))`, Order.ATOMIC];
        case 'bool':
            ensureTextToBoolHelper();
            return [`ck_text_to_bool(${s})`, Order.ATOMIC];
        case 'char':
            return [`((${s}).length() > 0 ? (${s}).charAt(0) : '\\0')`, Order.ATOMIC];
        case 'int8_t':
            return [`((int8_t)(${s}.toInt()))`, Order.ATOMIC];
        case 'uint8_t':
            arduinoGenerator.addInclude('stdlib', '#include <stdlib.h>');
            return [`((uint8_t)strtoul((${s}).c_str(), NULL, 10))`, Order.ATOMIC];
        case 'byte':
            arduinoGenerator.addInclude('stdlib', '#include <stdlib.h>');
            return [`((byte)strtoul((${s}).c_str(), NULL, 10))`, Order.ATOMIC];
        case 'int16_t':
            return [`((int16_t)(${s}.toInt()))`, Order.ATOMIC];
        case 'uint16_t':
            arduinoGenerator.addInclude('stdlib', '#include <stdlib.h>');
            return [`((uint16_t)strtoul((${s}).c_str(), NULL, 10))`, Order.ATOMIC];
        case 'int32_t':
            return [`((int32_t)(${s}.toInt()))`, Order.ATOMIC];
        case 'uint32_t':
            arduinoGenerator.addInclude('stdlib', '#include <stdlib.h>');
            return [`((uint32_t)strtoul((${s}).c_str(), NULL, 10))`, Order.ATOMIC];
        default:
            return [`((int)(${s}.toInt()))`, Order.ATOMIC];
    }
};

arduinoGenerator.forBlock['text_starts_ends_custom'] = function (block) {
    const text = arduinoGenerator.valueToCode(block, 'TEXT', Order.ATOMIC) || '""';
    const pattern = arduinoGenerator.valueToCode(block, 'PATTERN', Order.ATOMIC) || '""';
    const mode = block.getFieldValue('MODE') || 'STARTS';
    const fn = mode === 'ENDS' ? 'endsWith' : 'startsWith';
    return [`(String(${text}).${fn}(String(${pattern})))`, Order.ATOMIC];
};

arduinoGenerator.forBlock['text_ascii_from_number_custom'] = function (block) {
    const num = arduinoGenerator.valueToCode(block, 'NUM', Order.ATOMIC) || '65';
    return [`((char)(${num}))`, Order.ATOMIC];
};

arduinoGenerator.forBlock['text_ascii_to_number_custom'] = function (block) {
    const ch = arduinoGenerator.valueToCode(block, 'CHAR', Order.ATOMIC) || `'A'`;
    return [`((int)(String(${ch}).length() > 0 ? String(${ch}).charAt(0) : '\\0'))`, Order.ATOMIC];
};

arduinoGenerator.forBlock['text_substring_custom'] = function (block) {
    ensureTextSubstringHelper();
    const text = arduinoGenerator.valueToCode(block, 'TEXT', Order.ATOMIC) || '""';
    const start = arduinoGenerator.valueToCode(block, 'START', Order.ATOMIC) || '1';
    const end = arduinoGenerator.valueToCode(block, 'END', Order.ATOMIC) || '1';
    return [`ck_text_substr_1_based(String(${text}), (int)(${start}), (int)(${end}))`, Order.ATOMIC];
};

arduinoGenerator.forBlock['text_case_convert_custom'] = function (block) {
    ensureTextCaseHelper();
    const mode = block.getFieldValue('MODE') || 'UPPER';
    const text = arduinoGenerator.valueToCode(block, 'TEXT', Order.ATOMIC) || '""';
    const upper = mode === 'UPPER' ? 'true' : 'false';
    return [`ck_text_case_convert(String(${text}), ${upper})`, Order.ATOMIC];
};

arduinoGenerator.forBlock['text_trim_custom'] = function (block) {
    ensureTextTrimHelper();
    const mode = block.getFieldValue('MODE') || 'BOTH';
    const text = arduinoGenerator.valueToCode(block, 'TEXT', Order.ATOMIC) || '""';
    const trimMode = mode === 'LEFT' ? '1' : mode === 'RIGHT' ? '2' : '0';
    return [`ck_text_trim_mode(String(${text}), ${trimMode})`, Order.ATOMIC];
};

arduinoGenerator.forBlock['text_count_occurrence_custom'] = function (block) {
    ensureTextCountHelper();
    const needle = arduinoGenerator.valueToCode(block, 'NEEDLE', Order.ATOMIC) || '""';
    const haystack = arduinoGenerator.valueToCode(block, 'HAYSTACK', Order.ATOMIC) || '""';
    return [`ck_text_count_occurrence(String(${haystack}), String(${needle}))`, Order.ATOMIC];
};

arduinoGenerator.forBlock['text_replace_all_custom'] = function (block) {
    ensureTextReplaceAllHelper();
    const text = arduinoGenerator.valueToCode(block, 'TEXT', Order.ATOMIC) || '""';
    const from = arduinoGenerator.valueToCode(block, 'FROM', Order.ATOMIC) || '""';
    const to = arduinoGenerator.valueToCode(block, 'TO', Order.ATOMIC) || '""';
    return [`ck_text_replace_all(String(${text}), String(${from}), String(${to}))`, Order.ATOMIC];
};

arduinoGenerator.forBlock['text_reverse_custom'] = function (block) {
    ensureTextReverseHelper();
    const text = arduinoGenerator.valueToCode(block, 'TEXT', Order.ATOMIC) || '""';
    return [`ck_text_reverse(String(${text}))`, Order.ATOMIC];
};

// --- Wi-Fi Blocks ---

arduinoGenerator.forBlock['wifi_connect'] = function (block) {
    const ssid = escapeCppString(block.getFieldValue('SSID'));
    const password = escapeCppString(block.getFieldValue('PASSWORD'));

    ensureWifiSupport();

    // Setup code
    // @ts-ignore
    arduinoGenerator.setups_['wifi_mode'] = 'WiFi.mode(WIFI_STA);';
    // @ts-ignore
    arduinoGenerator.setups_['wifi_begin'] = `WiFi.begin("${ssid}", "${password}");`;

    // We don't block in setup, user can use wait block
    return `  // Wi-Fi connection initiated in setup\n`;
};

arduinoGenerator.forBlock['wifi_wait_until_ready'] = function (block) {
    ensureWifiSupport();
    ensureSerialSetup();
    return `  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\\nWiFi Connected!");\n`;
};

arduinoGenerator.forBlock['wifi_local_ip'] = function (block) {
    ensureWifiSupport();
    return ['WiFi.localIP().toString()', Order.ATOMIC];
};

arduinoGenerator.forBlock['wifi_set_protocol'] = function (block) {
    const protocol = block.getFieldValue('PROTOCOL');

    // Require WiFi.h and esp_wifi.h for low-level protocol setting
    ensureWifiSupport();
    arduinoGenerator.addInclude('esp_wifi', '#if defined(ARDUINO_ARCH_ESP32)\n#include <esp_wifi.h>\n#endif');

    if (protocol === 'AUTO') {
        return '  // Protocol set to Auto (Default)\n';
    }

    return `#if defined(ARDUINO_ARCH_ESP32)\n  esp_wifi_set_protocol(WIFI_IF_STA, ${protocol});\n#endif\n`;
};

arduinoGenerator.forBlock['wifi_get_rssi'] = function (block) {
    ensureWifiSupport();
    return ['WiFi.RSSI()', Order.ATOMIC];
};

arduinoGenerator.forBlock['wifi_get_channel'] = function (block) {
    ensureWifiSupport();
    return ['WiFi.channel()', Order.ATOMIC];
};
