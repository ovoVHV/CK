import { invoke } from '@tauri-apps/api/core';
import { convertFileSrc } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { readDir, readFile, readTextFile, stat } from '@tauri-apps/plugin-fs';
import * as Blockly from 'blockly';
import arduinoGenerator from '../components/arduino_generator';
import { getPinsAsDropdown } from '../config/boards';
import {
    BOARD_PIN_DROPDOWN_REGISTRY,
    UNDECLARED_BOARD_PIN,
    type BoardPinDropdownIdentity,
} from './board_pin_registry';
import { bindDynamicBoardPinTemplates } from './board_pin_templates';
import {
    bindDeclarativeGeneratorFunction,
    isSafeDeclarativeEntrypoint,
    parseDeclarativeBlockDocument,
    parseDeclarativeGeneratorDocument,
    parseDeclarativeToolboxDocument,
    validateDeclarativeToolboxXml,
} from './declarative_block_runtime';

const EXT_LOADER_RUNTIME_REV = 'ck-ext-compat-2026-02-27c';
console.info(`[Extensions] Loader runtime ${EXT_LOADER_RUNTIME_REV}`);

// ── Prefetch cache: read all extension files in parallel upfront ──
const _prefetchCache = new Map<string, string>();

async function readTextFileCached(path: string): Promise<string> {
    const norm = path.replace(/\\/g, '/');
    const cached = _prefetchCache.get(norm);
    if (cached !== undefined) {
        return cached;
    }
    return readTextFile(path);
}

/**
 * Pre-read all declarative extension files (blocks JSON, ck-generator JSON,
 * toolbox JSON/XML) in
 * parallel so that subsequent sequential registration calls hit memory instead
 * of making individual IPC round-trips. Call once before the registration loop.
 */
export async function prefetchExtensionFiles(exts: ExtensionInfo[]): Promise<void> {
    const paths = new Set<string>();
    for (const ext of exts) {
        const d = ext.dir_path.replace(/\\/g, '/').replace(/\/+$/g, '');
        if (ext.blocks_path) paths.add(ext.blocks_path.replace(/\\/g, '/'));
        if (ext.toolbox_path) paths.add(ext.toolbox_path.replace(/\\/g, '/'));
        if (ext.generator_path) paths.add(ext.generator_path.replace(/\\/g, '/'));
        paths.add(`${d}/block.json`);
        paths.add(`${d}/blocks/blocks.json`);
        paths.add(`${d}/toolbox.json`);
        paths.add(`${d}/blocks/toolbox.xml`);
        paths.add(`${d}/toolbox.xml`);
        if (ext.has_generator) {
            paths.add(`${d}/ck-generator.json`);
            paths.add(`${d}/blocks/ck-generator.json`);
        }
    }
    const results = await Promise.allSettled(
        Array.from(paths).map(async (p) => {
            try {
                const content = await readTextFile(p);
                _prefetchCache.set(p, content);
            } catch { /* miss is fine, fallback path will handle */ }
        })
    );
}

export interface ExtensionInfo {
    id: string;
    name: string;
    dir_path: string;
    has_generator: boolean;
    blocks_path?: string;
    generator_path?: string;
    toolbox_path?: string;
    runtime_content_sha256?: string;
}

const EXTENSION_VISUAL_PALETTE = [
    '#0F8F83',
    '#3B82C4',
    '#7C5AC7',
    '#D97706',
    '#C2417B',
    '#5A8F29',
    '#C65D32',
    '#4F6FB4',
    '#A34F9C',
    '#287F9D',
] as const;

const stableColourIndex = (value: string): number => {
    let hash = 2166136261;
    for (const char of String(value || '')) {
        hash ^= char.charCodeAt(0);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0) % EXTENSION_VISUAL_PALETTE.length;
};

export function assignExtensionVisualColours(runtimeKeys: string[]): Map<string, string> {
    const colours = new Map<string, string>();
    const used = new Set<number>();

    for (const rawKey of runtimeKeys) {
        const key = String(rawKey || '').trim();
        if (!key || colours.has(key)) continue;

        let index = stableColourIndex(key);
        if (used.size < EXTENSION_VISUAL_PALETTE.length) {
            while (used.has(index)) {
                index = (index + 1) % EXTENSION_VISUAL_PALETTE.length;
            }
            used.add(index);
        }
        colours.set(key, EXTENSION_VISUAL_PALETTE[index]);
    }

    return colours;
}

const hasExplicitVisualColour = (value: any): boolean => {
    const raw = String(value ?? '').trim();
    return !!raw && !/^\d+(?:\.\d+)?$/.test(raw);
};

const resolveBlocklyApi = (candidate?: any): any => {
    const fallback = Blockly as any;
    const candidates = [candidate, candidate?.default, fallback].filter(Boolean);

    for (const item of candidates) {
        if (item?.defineBlocksWithJsonArray || item?.common?.defineBlocksWithJsonArray || item?.Blocks) {
            return item;
        }
    }

    return fallback;
};

const compatInputDefaultsByBlockType = new Map<string, Record<string, any>>();
type CompatVariableFieldMeta = { defaultType: string; variableTypes: string[] | null };
const compatVariableFieldMetaByBlockType = new Map<string, Record<string, CompatVariableFieldMeta>>();
const compatDropdownShadowDefs = new Map<string, any>();
const compatValidatorFieldNamesByExtension = new Map<string, Set<string>>();
const extensionBlockOwners = new Map<string, string>();
const extensionBlockVisualColours = new Map<string, string>();
const extensionGeneratorOwners = new Map<string, string>();

export interface DisallowedExtensionBlockRuntime {
    blockType: string;
    ownerExtensionId: string;
}

/**
 * Exact-package compile guard for extension runtimes that remain registered in
 * Blockly's process-wide maps after a board switch. Registration is cached for
 * responsiveness, but an old package's generator must not participate in the
 * current package merely because both packages share one Arduino FQBN.
 */
export const findDisallowedExtensionBlockRuntimes = (
    blockTypes: Iterable<string>,
    allowedExtensionIds: ReadonlySet<string>,
): DisallowedExtensionBlockRuntime[] => {
    const violations = new Map<string, DisallowedExtensionBlockRuntime>();
    for (const rawType of blockTypes) {
        const blockType = String(rawType || '').trim();
        if (!blockType || isProtectedCoreBlockType(blockType)) continue;
        const ownerExtensionId = extensionBlockOwners.get(blockType);
        if (!ownerExtensionId || allowedExtensionIds.has(ownerExtensionId)) continue;
        violations.set(blockType, { blockType, ownerExtensionId });
    }
    return Array.from(violations.values()).sort((left, right) => (
        left.blockType.localeCompare(right.blockType)
    ));
};
const CORE_BLOCK_TYPES = new Set<string>();
const CORE_BLOCK_IMPLS = new Map<string, any>();
let coreBlockSnapshotLocked = false;

export function syncExtensionBlockVisualColour(block: any): boolean {
    const type = String(block?.type || '').trim();
    const visualColour = extensionBlockVisualColours.get(type);
    if (!visualColour || isProtectedCoreBlockType(type)) return false;
    const currentColour = String(block?.getColour?.() || '').toLowerCase();
    if (currentColour === visualColour.toLowerCase()) return false;
    try {
        block?.setColour?.(visualColour);
        return true;
    } catch {
        return false;
    }
}
const CORE_BLOCK_TYPE_HINTS = new Set<string>([
    'controls_setup_custom',
    'controls_loop_custom',
    'arduino_setup',
    'arduino_loop',
    'base_setup',
    'base_loop',
    'serial_setup',
    'serial_begin',
    'serial_print',
    'serial_println',
    'controls_delay',
    'variables_declare',
    'math_auto_add_or_minus',
    'text_char_literal_custom',
    'text_char',
]);

const sanitizeCompatId = (value: string): string => {
    return String(value || '')
        .replace(/[^a-zA-Z0-9_]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 80) || 'x';
};

const captureCoreBlocksFrom = (blocksObj: any, hintsOnly = false): void => {
    if (!blocksObj || typeof blocksObj !== 'object') return;
    for (const [rawType, impl] of Object.entries(blocksObj)) {
        const type = String(rawType || '').trim();
        if (!type || isCompatShadowType(type)) continue;
        if (hintsOnly && !CORE_BLOCK_TYPE_HINTS.has(type)) continue;
        if (!impl) continue;
        if (typeof impl === 'object' && typeof (impl as any).init !== 'function') continue;
        if (!CORE_BLOCK_TYPES.has(type)) CORE_BLOCK_TYPES.add(type);
        if (!CORE_BLOCK_IMPLS.has(type)) CORE_BLOCK_IMPLS.set(type, impl);
    }
};

const ensureCoreBlockSnapshot = (blocklyApi?: any): void => {
    const globalBlocks = (globalThis as any)?.Blockly?.Blocks;
    if (!coreBlockSnapshotLocked) {
        captureCoreBlocksFrom((Blockly as any)?.Blocks, false);
        captureCoreBlocksFrom(blocklyApi?.Blocks, false);
        captureCoreBlocksFrom(globalBlocks, false);
        coreBlockSnapshotLocked = CORE_BLOCK_TYPES.size > 0;
    }
    // Keep critical aliases restorable even if blockly setup loads after this module.
    captureCoreBlocksFrom((Blockly as any)?.Blocks, true);
    captureCoreBlocksFrom(blocklyApi?.Blocks, true);
    captureCoreBlocksFrom(globalBlocks, true);
};

const isCompatShadowType = (type: string): boolean => {
    return type.startsWith('ck_shadow_dropdown_') || type.startsWith('ck_shadow_number_');
};

const isProtectedCoreBlockType = (type: string): boolean => {
    const normalized = String(type || '').trim();
    if (!normalized) return false;
    if (isCompatShadowType(normalized)) return false;
    return CORE_BLOCK_TYPES.has(normalized) || CORE_BLOCK_TYPE_HINTS.has(normalized);
};

const extensionPriorityScore = (extId: string): number => {
    const id = String(extId || '').toLowerCase();
    let score = 100;
    // Prefer feature-specific extensions over generic core shims when block types conflict.
    if (id.includes('lib-core-') || id.includes('-core-') || id.endsWith('-core')) score += 100;
    if (id.includes('compat') || id.includes('legacy')) score += 40;
    if (id.includes('demo') || id.includes('example') || id.includes('test')) score += 20;
    return score;
};

const shouldPreferCandidateOwner = (currentOwnerId: string, candidateId: string): boolean => {
    if (!currentOwnerId) return true;
    if (currentOwnerId === candidateId) return true;

    // When both are library extensions (lib_...) for the same base library but
    // from different board/arch directories (e.g. arduino_avr_nano vs esp32_...),
    // always allow the candidate to take ownership.  Only one board's libraries
    // appear in the toolbox at a time, so the later-registered version (matching
    // the current board) should win.
    const curLower = String(currentOwnerId || '').toLowerCase();
    const candLower = String(candidateId || '').toLowerCase();
    if (curLower.startsWith('lib_') && candLower.startsWith('lib_')) {
        const baseLibName = (id: string): string => {
            // lib_c_users_..._libraries_<scope>_<libname> → extract <libname>
            const parts = id.split('_');
            return parts.length > 0 ? parts[parts.length - 1] : id;
        };
        if (baseLibName(curLower) === baseLibName(candLower) && curLower !== candLower) {
            return true;
        }
    }

    const currentScore = extensionPriorityScore(currentOwnerId);
    const candidateScore = extensionPriorityScore(candidateId);
    if (candidateScore !== currentScore) return candidateScore < currentScore;
    return String(candidateId || '').localeCompare(String(currentOwnerId || '')) < 0;
};

const restoreProtectedCoreBlocks = (blocklyApi?: any): void => {
    ensureCoreBlockSnapshot(blocklyApi);
    const blocksObj = blocklyApi?.Blocks || (Blockly as any)?.Blocks;
    if (!blocksObj || typeof blocksObj !== 'object') return;
    for (const [type, impl] of CORE_BLOCK_IMPLS) {
        if (!type || !impl) continue;
        if (blocksObj[type] !== impl) {
            blocksObj[type] = impl;
        }
    }
};

const extractSetValidatorFieldNames = (generatorCode: string): Set<string> => {
    const out = new Set<string>();
    const safeCode = String(generatorCode || '');
    const re = /getField\s*\(\s*['"]([^'"]+)['"]\s*\)\s*\.setValidator\s*\(/g;
    let m: RegExpExecArray | null = null;
    while ((m = re.exec(safeCode))) {
        const fieldName = String(m[1] || '').trim().toUpperCase();
        if (fieldName) out.add(fieldName);
    }
    return out;
};

const normalizeBlockDefs = (
    blockJson: any,
    blocklyApi?: any,
    preserveDropdownFields?: Set<string>,
    fallbackColour?: string,
): any[] => {
    let defs: any[] = [];
    if (Array.isArray(blockJson)) {
        defs = blockJson;
    } else if (Array.isArray(blockJson?.blocks)) {
        defs = blockJson.blocks;
    } else if (blockJson && typeof blockJson === 'object' && typeof blockJson.type === 'string') {
        defs = [blockJson];
    } else {
        return [];
    }

    if (fallbackColour) {
        defs.forEach((def) => {
            if (!def || typeof def !== 'object' || def.style || def.styleName) return;
            def.colour = fallbackColour;
        });
    }

    const fieldRegistry = blocklyApi?.fieldRegistry || (Blockly as any)?.fieldRegistry;
    const blocklyRegistry = blocklyApi?.registry || (Blockly as any)?.registry;
    const hasRegisteredFieldType = (typeName: string): boolean => {
        if (!typeName) return false;
        try {
            if (fieldRegistry && typeof fieldRegistry.getClass === 'function') {
                return !!fieldRegistry.getClass(typeName);
            }
        } catch { }
        try {
            if (blocklyRegistry && typeof blocklyRegistry.hasItem === 'function') {
                const fieldType = blocklyRegistry?.Type?.FIELD || 'field';
                if (blocklyRegistry.hasItem(fieldType, typeName)) return true;
            } else if (blocklyRegistry && typeof blocklyRegistry.getObject === 'function') {
                const fieldType = blocklyRegistry?.Type?.FIELD || 'field';
                // Fallback for older registry wrappers.
                try {
                    if (blocklyRegistry.getObject(fieldType, typeName, false)) return true;
                } catch { }
            }
        } catch { }
        return false;
    };

    const builtinFieldTypes = new Set([
        'field_input',
        'field_checkbox',
        'field_variable',
        'field_label',
        'field_label_serializable',
        'field_angle',
        'field_multilineinput',
        'field_grid_dropdown'
    ]);

    const normalizeColorHex = (value: any): string => {
        const raw = String(value || '').trim();
        if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw;
        const upper = raw.toUpperCase();
        const named: Record<string, string> = {
            'CRGB::WHITE': '#ffffff',
            'CRGB::BLACK': '#000000',
            'CRGB::RED': '#ff0000',
            'CRGB::GREEN': '#00ff00',
            'CRGB::BLUE': '#0000ff',
            'CRGB::YELLOW': '#ffff00',
            'CRGB::CYAN': '#00ffff',
            'CRGB::MAGENTA': '#ff00ff'
        };
        return named[upper] || '#ffffff';
    };
    const hasColourFieldType = hasRegisteredFieldType('field_colour');

    const normalizeDropdownOptions = (arg: any): any => {
        if (!arg || arg.type !== 'field_dropdown') return arg;
        if (Array.isArray(arg.options)) {
            arg.options = arg.options.map((opt: any) => {
                if (Array.isArray(opt)) {
                    return [String(opt[0] ?? ''), String(opt[1] ?? '')];
                }
                return opt;
            });
            return arg;
        }
        if (typeof arg.options !== 'string') return arg;

        const val = arg.options;
        if (val === '${board.i2c}') {
            arg.options = [["Wire", "Wire"], ["Wire1", "Wire1"], ["Wire2", "Wire2"]];
        } else if (val === '${board.spi}') {
            arg.options = [["SPI", "SPI"], ["SPI1", "SPI1"], ["SPI2", "SPI2"]];
        } else if (val === '${board.serial}') {
            arg.options = [["Serial", "Serial"], ["Serial1", "Serial1"], ["Serial2", "Serial2"]];
        } else {
            arg.options = [[`[compat: ${val}]`, ""]];
        }
        return arg;
    };

    const normalizeArg = (
        def: any,
        arg: any,
        argKey: string,
        argIndex: number,
        compatDefaults: Record<string, any>,
        usedShadowTypes: Set<string>,
        variableFieldMeta: Record<string, CompatVariableFieldMeta>
    ): any => {
        if (!arg || typeof arg !== 'object') return arg;
        const rawType = String(arg.type || '').trim();
        if (!rawType) return arg;
        const lower = rawType.toLowerCase();

        if (lower === 'inputsinline') {
            def.inputsInline = true;
            return {
                type: 'input_dummy',
                name: String(arg.name || `INLINE_${argKey}_${argIndex}`)
            };
        }

        if (lower === 'field_dropdown') {
            const normalized = normalizeDropdownOptions({ ...arg });
            const argName = String(normalized.name || `VALUE_${argKey}_${argIndex}`);
            const options = Array.isArray(normalized.options) && normalized.options.length
                ? normalized.options
                : [["", ""]];
            if (preserveDropdownFields?.has(argName.toUpperCase())) {
                return {
                    ...normalized,
                    type: 'field_dropdown',
                    name: argName,
                    options
                };
            }
            const shadowType = `ck_shadow_dropdown_${sanitizeCompatId(def.type || 'block')}_${sanitizeCompatId(argName)}`;

            if (!compatDropdownShadowDefs.has(shadowType)) {
                compatDropdownShadowDefs.set(shadowType, {
                    type: shadowType,
                    message0: '%1',
                    args0: [
                        {
                            type: 'field_dropdown',
                            name: 'VALUE',
                            options
                        }
                    ],
                    output: null,
                    colour: def.colour || '#999999',
                    tooltip: ''
                });
            }

            usedShadowTypes.add(shadowType);
            compatDefaults[argName] = {
                mode: 'dropdown',
                shadowType,
                shadowField: 'VALUE',
                value: String(normalized.value ?? options?.[0]?.[1] ?? '')
            };

            const converted: any = {
                type: 'input_value',
                name: argName
            };
            if (typeof normalized.check !== 'undefined') converted.check = normalized.check;
            return converted;
        }

        if (lower === 'field_number') {
            const argName = String(arg.name || `NUM_${argKey}_${argIndex}`);
            const shadowType = `ck_shadow_number_${sanitizeCompatId(def.type || 'block')}_${sanitizeCompatId(argName)}`;
            if (!compatDropdownShadowDefs.has(shadowType)) {
                compatDropdownShadowDefs.set(shadowType, {
                    type: shadowType,
                    message0: '%1',
                    args0: [
                        {
                            type: 'field_number',
                            name: 'NUM',
                            value: Number(arg.value ?? 0)
                        }
                    ],
                    output: 'Number',
                    colour: def.colour || '#999999',
                    tooltip: ''
                });
            }
            usedShadowTypes.add(shadowType);
            compatDefaults[argName] = {
                mode: 'number',
                shadowType,
                shadowField: 'NUM',
                value: String(arg.value ?? 0)
            };
            return {
                type: 'input_value',
                name: argName,
                check: 'Number'
            };
        }

        if (lower === 'field_variable') {
            const normalizedVarArg: any = {
                ...arg,
                type: 'field_variable',
                name: String(arg.name || 'VAR')
            };

            const normalizedVariableTypes = Array.isArray(arg.variableTypes)
                ? arg.variableTypes
                    .map((item: any) => String(item ?? '').trim())
                    .filter((item: string) => !!item)
                : [];
            if (normalizedVariableTypes.length > 0) {
                normalizedVarArg.variableTypes = normalizedVariableTypes;
            } else {
                delete normalizedVarArg.variableTypes;
            }

            const explicitDefaultType = String(arg.defaultType ?? arg.variabletype ?? '').trim();
            if (explicitDefaultType) {
                normalizedVarArg.defaultType = explicitDefaultType;
            } else {
                delete normalizedVarArg.defaultType;
            }

            const normalizedNameKey = String(normalizedVarArg.name || 'VAR').trim().toUpperCase();
            const allowedTypes = Array.isArray(normalizedVarArg.variableTypes)
                ? normalizedVarArg.variableTypes
                    .map((item: any) => String(item ?? '').trim())
                    .filter((item: string) => item.length > 0)
                : [];
            const inferredDefaultType =
                String(normalizedVarArg.defaultType ?? '').trim() ||
                (allowedTypes.length > 0 ? allowedTypes[0] : '');
            variableFieldMeta[normalizedNameKey] = {
                defaultType: inferredDefaultType,
                variableTypes: allowedTypes.length > 0 ? allowedTypes : null
            };

            return normalizedVarArg;
        }

        if (builtinFieldTypes.has(lower)) {
            return arg;
        }

        if (
            lower === 'field_colour_hsv_sliders' ||
            lower === 'field_color_hsv_sliders' ||
            lower === 'field_color'
        ) {
            const colorHex = normalizeColorHex(arg.colour || arg.color || arg.value || arg.text);
            if (!hasColourFieldType) {
                return {
                    ...arg,
                    type: 'field_input',
                    name: String(arg.name || 'COLOR'),
                    text: colorHex
                };
            }
            return {
                ...arg,
                type: 'field_colour',
                colour: colorHex,
                name: String(arg.name || 'COLOR')
            };
        }

        if (lower === 'field_image_preview') {
            return {
                ...arg,
                type: 'field_image_preview',
                name: String(arg.name || 'IMAGE_PREVIEW')
            };
        }

        if (lower === 'field_multilinetext') {
            return {
                ...arg,
                type: 'field_multilineinput',
                name: String(arg.name || 'TEXT'),
                text: String(arg.text || arg.value || '')
            };
        }

        if (lower.startsWith('field_')) {
            if (lower.includes('colour') || lower.includes('color')) {
                const colorHex = normalizeColorHex(arg.colour || arg.color || arg.value || arg.text);
                if (!hasColourFieldType) {
                    return {
                        ...arg,
                        type: 'field_input',
                        name: String(arg.name || 'COLOR'),
                        text: colorHex
                    };
                }
                return {
                    ...arg,
                    type: 'field_colour',
                    colour: colorHex,
                    name: String(arg.name || 'COLOR')
                };
            }
            if (lower.includes('image') && lower.includes('preview')) {
                return {
                    ...arg,
                    type: 'field_image_preview',
                    name: String(arg.name || 'IMAGE_PREVIEW')
                };
            }
            if (hasRegisteredFieldType(rawType)) {
                return arg;
            }
            if (lower.includes('image') || lower.includes('bitmap')) {
                return {
                    ...arg,
                    type: 'field_label_serializable',
                    name: String(arg.name || 'IMAGE'),
                    text: String(arg.alt || arg.text || '[image]')
                };
            }
            return {
                ...arg,
                type: 'field_input',
                name: String(arg.name || 'VALUE'),
                text: String(arg.text || arg.value || '')
            };
        }

        return arg;
    };

    const allShadowTypes = new Set<string>();
    defs.forEach((def) => {
        if (!def || typeof def !== 'object') return;
        const defType = String(def.type || '').trim();
        if (defType && isProtectedCoreBlockType(defType)) {
            compatInputDefaultsByBlockType.delete(defType);
            compatVariableFieldMetaByBlockType.delete(defType);
            return;
        }
        const compatDefaults: Record<string, any> = {};
        const usedShadowTypes = new Set<string>();
        const variableFieldMeta: Record<string, CompatVariableFieldMeta> = {};
        const argKeys = Object.keys(def).filter((k) => /^args\d+$/.test(k));
        for (const argKey of argKeys) {
            if (!Array.isArray(def[argKey])) continue;
            const normalizedArgs = def[argKey]
                .map((rawArg: any, idx: number) => normalizeArg(def, rawArg, argKey, idx, compatDefaults, usedShadowTypes, variableFieldMeta))
                .map((arg: any) => normalizeDropdownOptions(arg));
            def[argKey] = normalizedArgs;
        }

        if (def.type) {
            if (Object.keys(compatDefaults).length > 0) {
                compatInputDefaultsByBlockType.set(String(def.type), compatDefaults);
            } else {
                compatInputDefaultsByBlockType.delete(String(def.type));
            }
            if (Object.keys(variableFieldMeta).length > 0) {
                compatVariableFieldMetaByBlockType.set(String(def.type), variableFieldMeta);
            } else {
                compatVariableFieldMetaByBlockType.delete(String(def.type));
            }
        }

        for (const shadowType of usedShadowTypes) {
            allShadowTypes.add(shadowType);
        }

        if (typeof def.extensions === 'string') {
            def.extensions = [def.extensions];
        }
    });

    const normalizedDefs = defs.filter((def) => {
        const type = String(def?.type || '').trim();
        if (!type) return false;
        return !isProtectedCoreBlockType(type);
    });

    const extraShadowDefs = Array.from(allShadowTypes)
        .map((type) => compatDropdownShadowDefs.get(type))
        .filter(Boolean);
    return [...normalizedDefs, ...extraShadowDefs];
};

const IMAGE_PREVIEW_PLACEHOLDER_TEXT = '\u70b9\u51fb\u9009\u62e9\u56fe\u7247\u6587\u4ef6';
const TFT_IMAGE_SOURCE_BYTES_MAX = 16 * 1024 * 1024;
const TFT_IMAGE_CACHE_ENTRY_BYTES_MAX = 64 * 1024 * 1024;
const TFT_IMAGE_CACHE_TOTAL_BYTES_MAX = 128 * 1024 * 1024;
const TFT_IMAGE_CACHE_ENTRIES_MAX = 64;

interface LoadedImageFromPath {
    imageElement: HTMLImageElement;
    previewSource: string;
    sourceBytes: number;
}

interface ManagedTftImageCacheEntry {
    filePath: string;
    fileName: string;
    originalWidth: number;
    originalHeight: number;
    /** Legacy runtime aliases may expose these shorter dimension names. */
    width?: number;
    height?: number;
    imageElement?: HTMLImageElement;
    processedAt: number;
    __ckCanonicalKey: string;
    __ckAliases: string[];
    __ckEstimatedBytes: number;
}

const managedTftImageEntries = new Map<string, ManagedTftImageCacheEntry>();
let managedTftImageBytes = 0;

class TftImageResourceLimitError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'TftImageResourceLimitError';
    }
}

const rawTftImageCache = (): Record<string, ManagedTftImageCacheEntry> => {
    if (typeof window === 'undefined') return {};
    return ((window as any).tftImageCache = (window as any).tftImageCache || {});
};

const canonicalTftImageKey = (filePath: string, fileName: string): string => {
    const path = String(filePath || '').trim().replace(/\\/g, '/').toLowerCase();
    if (path) return `path:${path}`;
    return `name:${String(fileName || '').trim().toLowerCase()}`;
};

const tftImageAliases = (filePath: string, fileName: string): string[] => (
    [...new Set([
        String(filePath || '').trim(),
        String(fileName || '').trim(),
        String(fileName || '').trim().toLowerCase(),
    ].filter(Boolean))]
);

const activeTftImageCacheKeys = (): Set<string> => {
    const keys = new Set<string>();
    try {
        const workspace = (Blockly as any)?.getMainWorkspace?.();
        const blocks = workspace?.getAllBlocks?.(false) || [];
        for (const block of blocks) {
            const raw = String(block?.getFieldValue?.('IMAGE_PREVIEW') || '').trim();
            if (!raw) continue;
            let filePath = raw;
            let fileName = '';
            if (raw.startsWith('{')) {
                try {
                    const parsed = JSON.parse(raw);
                    filePath = String(parsed?.filePath || parsed?.path || parsed?.file || '').trim();
                    fileName = String(parsed?.fileName || '').trim();
                } catch {
                    continue;
                }
            }
            if (!filePath && !fileName) continue;
            keys.add(canonicalTftImageKey(filePath, fileName || fileNameFromPath(filePath)));
        }
    } catch {
        // A workspace may be between injection and disposal. In that narrow
        // window the hard byte/count limit still applies without pin hints.
    }
    return keys;
};

const releaseManagedTftImageEntry = (entry: ManagedTftImageCacheEntry): void => {
    const cache = rawTftImageCache();
    for (const alias of entry.__ckAliases) {
        if (cache[alias] === entry) delete cache[alias];
    }
    if (managedTftImageEntries.get(entry.__ckCanonicalKey) === entry) {
        managedTftImageEntries.delete(entry.__ckCanonicalKey);
        managedTftImageBytes = Math.max(0, managedTftImageBytes - entry.__ckEstimatedBytes);
    }
};

const touchManagedTftImageEntry = (entry: ManagedTftImageCacheEntry): void => {
    const key = entry.__ckCanonicalKey;
    if (!key || managedTftImageEntries.get(key) !== entry) return;
    managedTftImageEntries.delete(key);
    managedTftImageEntries.set(key, entry);
};

const releaseTftImageCachePath = (filePath: string, fileName = ''): void => {
    const key = canonicalTftImageKey(filePath, fileName || fileNameFromPath(filePath));
    const entry = managedTftImageEntries.get(key);
    if (entry) releaseManagedTftImageEntry(entry);
};

export const releaseTftImageCache = (): void => {
    for (const entry of Array.from(managedTftImageEntries.values())) {
        releaseManagedTftImageEntry(entry);
    }
    const cache = rawTftImageCache();
    for (const alias of Object.keys(cache)) delete cache[alias];
    managedTftImageBytes = 0;
};

const cacheTftImageElement = (
    filePath: string,
    imageElement: HTMLImageElement | null,
    sourceBytes = 0,
    explicitFileName = '',
): ManagedTftImageCacheEntry | null => {
    if (typeof window === 'undefined' || !filePath || !imageElement) return null;
    const fileName = explicitFileName || fileNameFromPath(filePath);
    const width = Number(imageElement.naturalWidth || imageElement.width || 0);
    const height = Number(imageElement.naturalHeight || imageElement.height || 0);
    const decodedBytes = Number.isFinite(width) && Number.isFinite(height)
        ? Math.max(0, Math.round(width) * Math.round(height) * 4)
        : 0;
    const estimatedBytes = Math.max(decodedBytes, Math.max(0, Math.round(sourceBytes)));
    if (estimatedBytes > TFT_IMAGE_CACHE_ENTRY_BYTES_MAX) {
        throw new TftImageResourceLimitError(
            `Image requires about ${estimatedBytes} bytes in memory; CK allows at most ${TFT_IMAGE_CACHE_ENTRY_BYTES_MAX} bytes per cached TFT image. Resize the image and retry.`,
        );
    }

    const canonicalKey = canonicalTftImageKey(filePath, fileName);
    const previous = managedTftImageEntries.get(canonicalKey);
    if (previous) releaseManagedTftImageEntry(previous);

    const activeKeys = activeTftImageCacheKeys();
    while (
        managedTftImageEntries.size >= TFT_IMAGE_CACHE_ENTRIES_MAX
        || managedTftImageBytes + estimatedBytes > TFT_IMAGE_CACHE_TOTAL_BYTES_MAX
    ) {
        const oldest = Array.from(managedTftImageEntries.values()).find(
            candidate => !activeKeys.has(candidate.__ckCanonicalKey),
        );
        if (!oldest) break;
        releaseManagedTftImageEntry(oldest);
    }
    if (
        managedTftImageEntries.size >= TFT_IMAGE_CACHE_ENTRIES_MAX
        || managedTftImageBytes + estimatedBytes > TFT_IMAGE_CACHE_TOTAL_BYTES_MAX
    ) {
        throw new TftImageResourceLimitError(
            'TFT image cache reached its 64-image / 128 MiB safety limit. Active workspace images were kept so code generation remains deterministic. Remove unused image blocks or use smaller images, then retry.',
        );
    }

    const aliases = tftImageAliases(filePath, fileName);
    const entry: ManagedTftImageCacheEntry = {
        filePath,
        fileName,
        originalWidth: width,
        originalHeight: height,
        imageElement,
        processedAt: Date.now(),
        __ckCanonicalKey: canonicalKey,
        __ckAliases: aliases,
        __ckEstimatedBytes: estimatedBytes,
    };
    managedTftImageEntries.set(canonicalKey, entry);
    managedTftImageBytes += estimatedBytes;
    const cache = rawTftImageCache();
    for (const alias of aliases) cache[alias] = entry;
    return entry;
};

if (typeof window !== 'undefined' && !(window as any).__ckTftImageCacheUnloadBound) {
    (window as any).__ckTftImageCacheUnloadBound = true;
    window.addEventListener('beforeunload', releaseTftImageCache, { once: true });
}

const mimeFromPath = (filePath: string): string => {
    const lower = String(filePath || '').toLowerCase();
    if (lower.endsWith('.png')) return 'image/png';
    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
    if (lower.endsWith('.bmp')) return 'image/bmp';
    if (lower.endsWith('.gif')) return 'image/gif';
    if (lower.endsWith('.webp')) return 'image/webp';
    return 'application/octet-stream';
};

const loadImageFromPath = async (filePath: string): Promise<LoadedImageFromPath | null> => {
    const loadBySrc = async (src: string): Promise<HTMLImageElement | null> => {
        return await new Promise((resolve) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => resolve(null);
            img.src = src.startsWith('blob:')
                ? src
                : `${src}${src.includes('?') ? '&' : '?'}ckts=${Date.now()}`;
        });
    };

    try {
        // Prefer binary read + blob URL to avoid tainted canvas from custom protocol URLs.
        try {
            const metadata = await stat(filePath);
            if (metadata.size > TFT_IMAGE_SOURCE_BYTES_MAX) {
                throw new TftImageResourceLimitError(
                    `Image file is ${metadata.size} bytes; CK allows at most ${TFT_IMAGE_SOURCE_BYTES_MAX} bytes. Resize or recompress the image and retry.`,
                );
            }
        } catch (error) {
            // A provider may not expose metadata for every virtual path. Keep
            // the post-read check as a second gate, but never downgrade a
            // confirmed size-limit failure into the custom-protocol fallback.
            if (error instanceof TftImageResourceLimitError) throw error;
        }
        const bytes = await readFile(filePath);
        if (bytes.byteLength > TFT_IMAGE_SOURCE_BYTES_MAX) {
            throw new TftImageResourceLimitError(
                `Image file is ${bytes.byteLength} bytes; CK allows at most ${TFT_IMAGE_SOURCE_BYTES_MAX} bytes. Resize or recompress the image and retry.`,
            );
        }
        const blob = new Blob([bytes], { type: mimeFromPath(filePath) });
        const blobUrl = URL.createObjectURL(blob);
        try {
            const imageElement = await loadBySrc(blobUrl);
            if (!imageElement) return null;
            const converted = convertFileSrc(filePath);
            const previewSource = `${converted}${converted.includes('?') ? '&' : '?'}ckts=${Date.now()}`;
            return { imageElement, previewSource, sourceBytes: bytes.byteLength };
        } finally {
            // The decoded HTMLImageElement remains usable by the generator, but
            // the temporary Blob registry entry must never survive the read.
            URL.revokeObjectURL(blobUrl);
        }
    } catch (err) {
        if (err instanceof TftImageResourceLimitError) throw err;
        console.warn('[Extensions] readFile image load failed, fallback to convertFileSrc:', err);
        try {
            const src = convertFileSrc(filePath);
            const imageElement = await loadBySrc(src);
            return imageElement
                ? { imageElement, previewSource: imageElement.src || src, sourceBytes: 0 }
                : null;
        } catch {
            return null;
        }
    }
};

const ensureImageCacheEntry = (
    filePath: string,
    imageElement: HTMLImageElement | null,
    sourceBytes = 0,
): void => {
    cacheTftImageElement(filePath, imageElement, sourceBytes);
};

const registerImagePreviewFieldCompat = (blocklyApi: any): void => {
    try {
        const fieldRegistry = blocklyApi?.fieldRegistry || (Blockly as any)?.fieldRegistry;
        const blocklyRegistry = blocklyApi?.registry || (Blockly as any)?.registry;
        const BaseFieldTextInput = blocklyApi?.FieldTextInput || (Blockly as any)?.FieldTextInput;
        if (!fieldRegistry || !BaseFieldTextInput) return;

        const registerColourFieldAlias = () => {
            try {
                const fieldTypeKey = blocklyApi?.registry?.Type?.FIELD || (Blockly as any)?.registry?.Type?.FIELD || 'field';
                const hasColourField = (): boolean => {
                    try {
                        if (typeof fieldRegistry?.getClass === 'function' && fieldRegistry.getClass('field_colour')) {
                            return true;
                        }
                    } catch { }
                    try {
                        if (typeof blocklyRegistry?.hasItem === 'function') {
                            if (blocklyRegistry.hasItem(fieldTypeKey, 'field_colour')) return true;
                        } else {
                            const obj = blocklyRegistry?.getObject?.(fieldTypeKey, 'field_colour', false);
                            if (obj) return true;
                        }
                    } catch { }
                    return false;
                };

                if (hasColourField()) return;

                class FieldColourCompat extends BaseFieldTextInput {
                    constructor(value?: any, validator?: any, config?: any) {
                        const initial = String(value || config?.colour || config?.color || config?.text || '#ffffff');
                        super(initial, validator);
                        this.SERIALIZABLE = true;
                        if (typeof this.setSpellcheck === 'function') this.setSpellcheck(false);
                    }
                    static fromJson(options: any) {
                        return new FieldColourCompat(options?.colour || options?.color || options?.text || '#ffffff', undefined, options || {});
                    }
                }

                try {
                    if (typeof fieldRegistry?.register === 'function') {
                        fieldRegistry.register('field_colour', FieldColourCompat);
                    }
                } catch { }
                try {
                    if (typeof blocklyRegistry?.register === 'function') {
                        blocklyRegistry.register(fieldTypeKey, 'field_colour', FieldColourCompat);
                    }
                } catch { }

                if (!hasColourField()) {
                    console.warn('[Extensions] field_colour alias registration did not verify in registry');
                    return;
                }
                console.log('[Extensions] Registered compatibility field alias: field_colour');
            } catch (e) {
                console.warn('[Extensions] Failed to register field_colour compatibility alias:', e);
            }
        };
        registerColourFieldAlias();

        class FieldImagePreviewCompat extends BaseFieldTextInput {
            ckConfig_: any;
            placeholder_: string;

            constructor(value?: any, validator?: any, config?: any) {
                const initial = (typeof value === 'string' && value.trim()) ? value : '';
                super(initial || IMAGE_PREVIEW_PLACEHOLDER_TEXT, validator);
                this.ckConfig_ = config || {};
                this.placeholder_ = this.ckConfig_?.text || IMAGE_PREVIEW_PLACEHOLDER_TEXT;
                this.SERIALIZABLE = true;
                if (typeof this.setSpellcheck === 'function') {
                    this.setSpellcheck(false);
                }
            }

            static fromJson(options: any) {
                return new FieldImagePreviewCompat(options?.text || '', undefined, options || {});
            }

            doClassValidation_(newValue: any) {
                if (newValue === null || typeof newValue === 'undefined') return null;
                if (typeof newValue === 'string') return newValue;
                if (typeof newValue === 'object') {
                    try {
                        return JSON.stringify(newValue);
                    } catch {
                        return null;
                    }
                }
                return String(newValue);
            }

            getText() {
                const raw = String(this.getValue?.() || '');
                if (!raw || raw === this.placeholder_ || raw === IMAGE_PREVIEW_PLACEHOLDER_TEXT) {
                    return this.placeholder_;
                }
                const parsed = parseImagePreviewValue(raw);
                if (parsed?.fileName) return String(parsed.fileName);
                if (parsed?.filePath) return fileNameFromPath(String(parsed.filePath || '')) || this.placeholder_;
                return fileNameFromPath(raw) || this.placeholder_;
            }

            private parseState_(block: any) {
                const defaultWidth = Number(this.ckConfig_?.defaultWidth || 32) || 32;
                const defaultHeight = Number(this.ckConfig_?.defaultHeight || 32) || 32;
                const fallback = {
                    filePath: '',
                    fileName: '',
                    width: Number(block?.getFieldValue?.('WIDTH') || defaultWidth || 32),
                    height: Number(block?.getFieldValue?.('HEIGHT') || defaultHeight || 32),
                    x: Number(block?.getFieldValue?.('X') || 0),
                    y: Number(block?.getFieldValue?.('Y') || 0),
                    screenWidth: 320,
                    screenHeight: 240,
                    rotation: 0
                };

                const parsed = parseImagePreviewValue(this.getValue?.() || '');
                if (parsed && typeof parsed === 'object') {
                    const merged: any = {
                        ...fallback,
                        ...parsed
                    };
                    if (!merged.fileName && merged.filePath) {
                        merged.fileName = fileNameFromPath(String(merged.filePath || ''));
                    }
                    return merged;
                }
                return fallback;
            }

            private toSafeNum_(value: any, fallback: number, min = 0, max = 10000): number {
                const n = Number(value);
                if (!Number.isFinite(n)) return fallback;
                return Math.max(min, Math.min(max, Math.round(n)));
            }

            private commitState_(block: any, state: any) {
                const payload = {
                    filePath: String(state.filePath || ''),
                    fileName: String(state.fileName || fileNameFromPath(String(state.filePath || '')) || ''),
                    width: this.toSafeNum_(state.width, 32, 1, 4096),
                    height: this.toSafeNum_(state.height, 32, 1, 4096),
                    x: this.toSafeNum_(state.x, 0, -4096, 4096),
                    y: this.toSafeNum_(state.y, 0, -4096, 4096),
                    screenWidth: this.toSafeNum_(state.screenWidth, 320, 1, 4096),
                    screenHeight: this.toSafeNum_(state.screenHeight, 240, 1, 4096),
                    rotation: this.toSafeNum_(state.rotation, 0, 0, 270),
                    imageData: state.imageData || ''
                };
                this.setValue(JSON.stringify(payload));

                try {
                    const setField = (name: string, val: number) => {
                        const f = block?.getField?.(name);
                        if (f?.setValue) f.setValue(String(val));
                    };
                    setField('WIDTH', payload.width);
                    setField('HEIGHT', payload.height);
                    setField('X', payload.x);
                    setField('Y', payload.y);
                } catch { }
            }

            private renderPreview_(screenBox: HTMLElement, imgEl: HTMLImageElement, state: any) {
                const sw = this.toSafeNum_(state.screenWidth, 320, 1, 4096);
                const sh = this.toSafeNum_(state.screenHeight, 240, 1, 4096);
                const x = this.toSafeNum_(state.x, 0, -4096, 4096);
                const y = this.toSafeNum_(state.y, 0, -4096, 4096);
                const w = this.toSafeNum_(state.width, 32, 1, 4096);
                const h = this.toSafeNum_(state.height, 32, 1, 4096);

                const scale = Math.min(260 / sw, 180 / sh);
                const boxW = Math.max(40, Math.round(sw * scale));
                const boxH = Math.max(30, Math.round(sh * scale));
                screenBox.style.width = `${boxW}px`;
                screenBox.style.height = `${boxH}px`;

                imgEl.style.left = `${Math.round(x * scale)}px`;
                imgEl.style.top = `${Math.round(y * scale)}px`;
                imgEl.style.width = `${Math.max(1, Math.round(w * scale))}px`;
                imgEl.style.height = `${Math.max(1, Math.round(h * scale))}px`;
            }

            async showEditor_() {
                console.log('[Extensions] field_image_preview clicked');
                const dropDownDiv = blocklyApi?.DropDownDiv || (Blockly as any)?.DropDownDiv;
                const block = this.getSourceBlock && this.getSourceBlock();
                const state: any = this.parseState_(block);

                const onPicked = async () => {
                    try {
                        const selected = await openDialog({
                            multiple: false,
                            filters: [
                                {
                                    name: 'Images',
                                    extensions: ['png', 'jpg', 'jpeg', 'bmp', 'gif', 'webp']
                                }
                            ]
                        });
                        if (!selected || typeof selected !== 'string') return;

                        const loadedImage = await loadImageFromPath(selected);
                        const image = loadedImage?.imageElement || null;
                        if (image) {
                            // Cache admission is the memory gate. Do not commit a
                            // path that the generator cannot safely retain.
                            ensureImageCacheEntry(selected, image, loadedImage?.sourceBytes || 0);
                        }
                        state.filePath = selected;
                        state.fileName = fileNameFromPath(selected);
                        if (image) {
                            const iw = Number(image.naturalWidth || image.width || 0);
                            const ih = Number(image.naturalHeight || image.height || 0);
                            if (iw > 0 && ih > 0) {
                                state.width = iw;
                                state.height = ih;
                            }
                            state.imageData = loadedImage?.previewSource || '';
                        } else {
                            state.imageData = '';
                        }
                        this.commitState_(block, state);
                        try {
                            block?.workspace?.render?.();
                            block?.render?.();
                        } catch { }
                    } catch (e) {
                        console.error('[Extensions] field_image_preview open dialog failed:', e);
                    }
                };

                if (!dropDownDiv || typeof dropDownDiv.getContentDiv !== 'function' || typeof dropDownDiv.showPositionedByField !== 'function') {
                    await onPicked();
                    return;
                }

                const editor = document.createElement('div');
                editor.style.minWidth = '420px';
                editor.style.maxWidth = '760px';
                editor.style.padding = '14px';
                editor.style.background = '#fff';
                editor.style.display = 'flex';
                editor.style.flexDirection = 'column';
                editor.style.gap = '10px';
                editor.style.color = '#2b2b2b';

                const label = (text: string) => {
                    const el = document.createElement('div');
                    el.textContent = text;
                    el.style.fontSize = '14px';
                    el.style.fontWeight = '600';
                    return el;
                };

                const row = () => {
                    const el = document.createElement('div');
                    el.style.display = 'flex';
                    el.style.alignItems = 'center';
                    el.style.gap = '8px';
                    return el;
                };

                const inputNum = (val: any, width = '92px') => {
                    const el = document.createElement('input');
                    el.type = 'number';
                    el.value = String(val ?? '');
                    el.style.width = width;
                    el.style.padding = '6px 8px';
                    el.style.border = '1px solid #d0d0d0';
                    el.style.borderRadius = '6px';
                    return el;
                };

                const pathInput = document.createElement('input');
                pathInput.type = 'text';
                pathInput.value = String(state.filePath || state.fileName || '');
                pathInput.placeholder = IMAGE_PREVIEW_PLACEHOLDER_TEXT;
                pathInput.style.flex = '1';
                pathInput.style.padding = '8px 10px';
                pathInput.style.border = '2px solid #0b7cd5';
                pathInput.style.borderRadius = '8px';

                const openBtn = document.createElement('button');
                openBtn.textContent = '\u6253\u5f00';
                openBtn.style.padding = '8px 18px';
                openBtn.style.border = '0';
                openBtn.style.borderRadius = '8px';
                openBtn.style.background = '#0b7cd5';
                openBtn.style.color = '#fff';
                openBtn.style.fontWeight = '700';
                openBtn.style.cursor = 'pointer';
                openBtn.onclick = async () => {
                    await onPicked();
                };

                const fileRow = row();
                fileRow.appendChild(pathInput);
                fileRow.appendChild(openBtn);
                editor.appendChild(fileRow);

                editor.appendChild(label('\u56fe\u50cf\u5c3a\u5bf8'));
                const sizeRow = row();
                const wInput = inputNum(state.width);
                const hInput = inputNum(state.height);
                sizeRow.append('宽:', wInput, '高:', hInput);
                editor.appendChild(sizeRow);

                editor.appendChild(label('\u663e\u793a\u4f4d\u7f6e'));
                const posRow = row();
                const xInput = inputNum(state.x, '80px');
                const yInput = inputNum(state.y, '80px');
                posRow.append('X:', xInput, 'Y:', yInput);
                editor.appendChild(posRow);

                editor.appendChild(label('\u5c4f\u5e55\u8bbe\u7f6e'));
                const screenRow = row();
                const swInput = inputNum(state.screenWidth);
                const shInput = inputNum(state.screenHeight);
                const rotSelect = document.createElement('select');
                ['0', '90', '180', '270'].forEach(v => {
                    const opt = document.createElement('option');
                    opt.value = v;
                    opt.textContent = `${v}\u00b0`;
                    rotSelect.appendChild(opt);
                });
                rotSelect.value = String(state.rotation || 0);
                rotSelect.style.padding = '6px 8px';
                rotSelect.style.border = '1px solid #d0d0d0';
                rotSelect.style.borderRadius = '6px';
                screenRow.append('宽:', swInput, '高:', shInput, '旋转:', rotSelect);
                editor.appendChild(screenRow);

                editor.appendChild(label('\u56fe\u50cf\u9884\u89c8'));
                const previewWrap = document.createElement('div');
                previewWrap.style.width = '100%';
                previewWrap.style.minHeight = '170px';
                previewWrap.style.padding = '8px';
                previewWrap.style.background = '#f6f6f6';
                previewWrap.style.borderRadius = '8px';

                const screenBox = document.createElement('div');
                screenBox.style.position = 'relative';
                screenBox.style.margin = '0 auto';
                screenBox.style.background = '#000';
                screenBox.style.border = '2px solid #444';
                screenBox.style.overflow = 'hidden';

                const previewImg = document.createElement('img');
                previewImg.style.position = 'absolute';
                previewImg.style.left = '0';
                previewImg.style.top = '0';
                previewImg.style.objectFit = 'cover';
                previewImg.style.display = 'none';

                screenBox.appendChild(previewImg);
                previewWrap.appendChild(screenBox);
                editor.appendChild(previewWrap);

                const clearRow = row();
                clearRow.style.justifyContent = 'flex-end';
                const clearBtn = document.createElement('button');
                clearBtn.textContent = 'Clear';
                clearBtn.style.padding = '8px 20px';
                clearBtn.style.border = '0';
                clearBtn.style.borderRadius = '10px';
                clearBtn.style.background = '#ff493a';
                clearBtn.style.color = '#fff';
                clearBtn.style.fontWeight = '700';
                clearBtn.style.cursor = 'pointer';
                clearBtn.onclick = () => {
                    releaseTftImageCachePath(state.filePath, state.fileName);
                    state.filePath = '';
                    state.fileName = '';
                    state.imageData = '';
                    pathInput.value = '';
                    previewImg.src = '';
                    previewImg.style.display = 'none';
                    this.commitState_(block, state);
                };
                clearRow.appendChild(clearBtn);
                editor.appendChild(clearRow);

                const syncStateFromInputs = () => {
                    state.filePath = String(pathInput.value || '');
                    state.fileName = fileNameFromPath(state.filePath);
                    state.width = this.toSafeNum_(wInput.value, state.width || 32, 1, 4096);
                    state.height = this.toSafeNum_(hInput.value, state.height || 32, 1, 4096);
                    state.x = this.toSafeNum_(xInput.value, state.x || 0, -4096, 4096);
                    state.y = this.toSafeNum_(yInput.value, state.y || 0, -4096, 4096);
                    state.screenWidth = this.toSafeNum_(swInput.value, state.screenWidth || 320, 1, 4096);
                    state.screenHeight = this.toSafeNum_(shInput.value, state.screenHeight || 240, 1, 4096);
                    state.rotation = this.toSafeNum_(rotSelect.value, state.rotation || 0, 0, 270);
                    this.renderPreview_(screenBox, previewImg, state);
                    this.commitState_(block, state);
                };

                [wInput, hInput, xInput, yInput, swInput, shInput, rotSelect, pathInput].forEach(el => {
                    el.addEventListener('input', syncStateFromInputs);
                    el.addEventListener('change', syncStateFromInputs);
                });

                const loadPreviewIfAny = async () => {
                    if (state.imageData) {
                        previewImg.src = state.imageData;
                        previewImg.style.display = 'block';
                        this.renderPreview_(screenBox, previewImg, state);
                        return;
                    }
                    if (state.filePath) {
                        const loadedImage = await loadImageFromPath(String(state.filePath));
                        const image = loadedImage?.imageElement || null;
                        if (image) {
                            previewImg.src = loadedImage?.previewSource || '';
                            previewImg.style.display = 'block';
                            state.imageData = loadedImage?.previewSource || '';
                            ensureImageCacheEntry(
                                String(state.filePath),
                                image,
                                loadedImage?.sourceBytes || 0,
                            );
                        }
                    }
                    this.renderPreview_(screenBox, previewImg, state);
                };

                const contentDiv = dropDownDiv.getContentDiv();
                if (contentDiv) {
                    contentDiv.innerHTML = '';
                    contentDiv.appendChild(editor);
                }
                dropDownDiv.showPositionedByField(this, () => { });
                await loadPreviewIfAny();
            }
        }

        const existing = (typeof fieldRegistry.getClass === 'function')
            ? fieldRegistry.getClass('field_image_preview')
            : null;
        if (existing && (existing as any).__ckFieldImagePreviewCompat) {
            return;
        }
        if (existing && typeof fieldRegistry.unregister === 'function') {
            try {
                fieldRegistry.unregister('field_image_preview');
            } catch (e) {
                console.warn('[Extensions] Failed to unregister previous field_image_preview:', e);
            }
        }

        (FieldImagePreviewCompat as any).__ckFieldImagePreviewCompat = true;
        fieldRegistry.register('field_image_preview', FieldImagePreviewCompat);
        console.log('[Extensions] Registered compatibility custom field: field_image_preview');
    } catch (e) {
        console.warn('[Extensions] Failed to register field_image_preview compatibility field:', e);
    }
};

const fallbackRegisterBlocks = (blocklyApi: any, blockDefs: any[]): number => {
    if (!blockDefs.length) return 0;

    const blocksRegistry = blocklyApi.Blocks || {};
    let registered = 0;

    for (const def of blockDefs) {
        const type = def?.type;
        if (!type || typeof type !== 'string') continue;

        if (blocksRegistry[type]) continue;

        blocksRegistry[type] = {
            init: function () {
                this.jsonInit(def);
            }
        };
        registered++;
    }

    blocklyApi.Blocks = blocksRegistry;
    return registered;
};

const registerCompatShadowGenerators = (blockDefs: any[]): void => {
    const forBlock = (arduinoGenerator as any)?.forBlock;
    if (!forBlock || typeof forBlock !== 'object') return;
    const orderAtomic = Number((arduinoGenerator as any)?.ORDER_ATOMIC || 0);

    for (const def of blockDefs) {
        const type = String(def?.type || '');
        if (!type.startsWith('ck_shadow_dropdown_') && !type.startsWith('ck_shadow_number_')) continue;
        if (typeof forBlock[type] === 'function') continue;
        forBlock[type] = function (block: any) {
            const fieldName = type.startsWith('ck_shadow_number_') ? 'NUM' : 'VALUE';
            const value = String(block?.getFieldValue?.(fieldName) || '');
            return [value, orderAtomic];
        };
    }
};

const isColorLikeField = (field: any): boolean => {
    if (!field) return false;
    const ctorName = String(field?.constructor?.name || '').toLowerCase();
    const className = String(field?.class_ || '').toLowerCase();
    const kind = String(field?.SERIALIZABLE?.kind || '').toLowerCase();
    return ctorName.includes('colour') || ctorName.includes('color') || className.includes('colour') || className.includes('color') || kind.includes('colour') || kind.includes('color');
};

const fieldValueFromAny = (field: any): string | null => {
    if (!field) return null;
    try {
        if (typeof field.getValue === 'function') {
            const v = field.getValue();
            if (v !== null && typeof v !== 'undefined') return String(v);
        }
    } catch { }
    try {
        if (typeof field.getText === 'function') {
            const t = field.getText();
            if (t !== null && typeof t !== 'undefined') return String(t);
        }
    } catch { }
    return null;
};

const collectBlockFields = (block: any): any[] => {
    const out: any[] = [];
    if (!Array.isArray(block?.inputList)) return out;
    for (const input of block.inputList) {
        if (!input || !Array.isArray(input.fieldRow)) continue;
        for (const field of input.fieldRow) {
            if (field) out.push(field);
        }
    }
    return out;
};

const readValueFromInputTargetBlock = (targetBlock: any): string | null => {
    if (!targetBlock) return null;
    const tryFieldNames = ['VALUE', 'NUM', 'TEXT', 'BOOL', 'COLOR', 'COLOUR', 'VAR'];
    for (const fn of tryFieldNames) {
        try {
            const f = targetBlock?.getField?.(fn);
            const v = fieldValueFromAny(f);
            if (v !== null && typeof v !== 'undefined' && v !== '') return v;
        } catch { }
    }

    try {
        const fields = collectBlockFields(targetBlock);
        for (const f of fields) {
            const v = fieldValueFromAny(f);
            if (v !== null && typeof v !== 'undefined' && v !== '') return v;
        }
    } catch { }

    return null;
};

const buildSafeBlockProxy = (rawBlock: any) => {
    const originalGetFieldValue = (typeof rawBlock?.getFieldValue === 'function')
        ? rawBlock.getFieldValue.bind(rawBlock)
        : null;

    const fallbackFieldValue = (fieldName?: any): string => {
        const name = String(fieldName ?? '').trim();
        const lowerName = name.toLowerCase();
        const fields = collectBlockFields(rawBlock);

        if (typeof rawBlock?.getField === 'function' && name) {
            try {
                const direct = rawBlock.getField(name);
                const v = fieldValueFromAny(direct);
                if (v !== null) return v;
            } catch { }
        }

        if (name && fields.length) {
            for (const field of fields) {
                const fn = String(field?.name || '');
                if (!fn) continue;
                if (fn.toLowerCase() === lowerName) {
                    const v = fieldValueFromAny(field);
                    if (v !== null) return v;
                }
            }
        }

        if (name) {
            try {
                let inputTarget: any = null;
                if (typeof rawBlock?.getInputTargetBlock === 'function') {
                    inputTarget = rawBlock.getInputTargetBlock(name);
                }
                if (!inputTarget && typeof rawBlock?.getInput === 'function') {
                    const input = rawBlock.getInput(name);
                    if (input?.connection?.targetBlock) {
                        inputTarget = input.connection.targetBlock();
                    }
                }
                const v = readValueFromInputTargetBlock(inputTarget);
                if (v !== null) return v;
            } catch { }
        }

        const wantsColor = /color|colour/.test(lowerName);
        if (wantsColor && fields.length) {
            for (const field of fields) {
                if (!isColorLikeField(field)) continue;
                const v = fieldValueFromAny(field);
                if (v !== null) return v;
            }
        }

        for (const field of fields) {
            const v = fieldValueFromAny(field);
            if (v !== null && v !== '') return v;
        }

        return '';
    };

    return new Proxy(rawBlock, {
        get(target: any, prop: string | symbol, receiver: any) {
            if (prop === 'getFieldValue') {
                return (fieldName?: any) => {
                    try {
                        if (originalGetFieldValue) {
                            const v = originalGetFieldValue(fieldName);
                            if (v !== null && typeof v !== 'undefined') return v;
                        }
                    } catch { }
                    return fallbackFieldValue(fieldName);
                };
            }
            const val = Reflect.get(target, prop, receiver);
            if (typeof val === 'function') return val.bind(target);
            return val;
        }
    });
};

const wrapExtensionForBlockGenerators = (extId: string, beforeMap: Map<string, any>) => {
    const forBlock = (arduinoGenerator as any)?.forBlock;
    if (!forBlock || typeof forBlock !== 'object') return;

    const keys = Object.keys(forBlock);
    let wrappedCount = 0;

    for (const key of keys) {
        const original = forBlock[key];
        if (typeof original !== 'function') continue;
        if ((original as any).__ckFieldSafeWrapped) continue;
        const before = beforeMap.get(key);
        // Wrap newly-added generators and overwritten generators.
        // Skip only functions that are unchanged from pre-load snapshot.
        if (before && before === original) continue;

        const wrapped = function (this: any, ...args: any[]) {
            if (!args.length || !args[0] || typeof args[0] !== 'object') {
                return original.apply(this, args);
            }
            const patchedArgs = [buildSafeBlockProxy(args[0]), ...args.slice(1)];
            try {
                return original.apply(this, patchedArgs);
            } catch (err: any) {
                const msg = String(err?.message || err || '');
                if (msg.includes('reading \'replace\'') || msg.includes('Cannot read properties of null')) {
                    console.warn(`[Extensions] Safe field fallback intercepted generator error in ${extId}.${key}:`, err);
                    return '';
                }
                throw err;
            }
        };

        (wrapped as any).__ckFieldSafeWrapped = true;
        (wrapped as any).__ckOriginal = original;
        forBlock[key] = wrapped;
        wrappedCount++;
    }

    if (wrappedCount > 0) {
        console.log(`[Extensions] Wrapped ${wrappedCount} forBlock generators with safe field fallback for ${extId}`);
    }
};

const parseImagePreviewValue = (raw: any): any | null => {
    if (!raw) return null;
    if (typeof raw === 'object') return raw;
    if (typeof raw !== 'string') return null;
    const text = raw.trim();
    if (!text) return null;
    if (
        text === IMAGE_PREVIEW_PLACEHOLDER_TEXT ||
        text === '[object Object]' ||
        ((text.includes('\u70b9\u51fb') || text.toLowerCase().includes('click')) &&
            (text.includes('\u9009\u62e9') || text.toLowerCase().includes('select')) &&
            (text.includes('\u56fe\u7247') || text.toLowerCase().includes('image')))
    ) {
        return null;
    }
    const looksLikeJson = text.startsWith('{') || text.startsWith('[');
    const looksLikePath =
        /[\\/]/.test(text) ||
        /^[a-zA-Z]:/.test(text) ||
        /\.(png|jpg|jpeg|bmp|gif|webp)$/i.test(text);
    if (!looksLikeJson && !looksLikePath) return null;
    try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object') return parsed;
    } catch { }
    return { filePath: text };
};

const readImagePreviewFromBlock = (block: any): any | null => {
    try {
        const raw = block?.getFieldValue?.('IMAGE_PREVIEW');
        const parsed = parseImagePreviewValue(raw);
        if (parsed) return parsed;
    } catch { }

    try {
        const field = block?.getField?.('IMAGE_PREVIEW');
        if (!field) return null;
        if (typeof field.getValue === 'function') {
            const parsed = parseImagePreviewValue(field.getValue());
            if (parsed) return parsed;
        }
        if (typeof (field as any).value_ !== 'undefined') {
            const parsed = parseImagePreviewValue((field as any).value_);
            if (parsed) return parsed;
        }
    } catch { }

    return null;
};

const fileNameFromPath = (filePath: string): string => {
    const normalized = String(filePath || '').replace(/\\/g, '/');
    const parts = normalized.split('/');
    return parts[parts.length - 1] || '';
};

const firstNumeric = (...values: any[]): number => {
    for (const value of values) {
        const n = Number(value);
        if (Number.isFinite(n) && n > 0) return n;
    }
    return 0;
};

const extractPreviewDims = (preview: any): { width: number; height: number } => {
    const width = firstNumeric(
        preview?.width,
        preview?.w,
        preview?.imageWidth,
        preview?.imgWidth,
        preview?.naturalWidth,
        preview?.realWidth,
        preview?.displayWidth,
        preview?.sourceWidth,
        preview?.size?.width,
        preview?.image?.width,
        preview?.meta?.width
    );
    const height = firstNumeric(
        preview?.height,
        preview?.h,
        preview?.imageHeight,
        preview?.imgHeight,
        preview?.naturalHeight,
        preview?.realHeight,
        preview?.displayHeight,
        preview?.sourceHeight,
        preview?.size?.height,
        preview?.image?.height,
        preview?.meta?.height
    );
    return { width, height };
};

const extractPreviewFilePath = (preview: any): string => {
    const candidates = [
        preview?.filePath,
        preview?.path,
        preview?.file,
        preview?.url,
        preview?.src,
        preview?.imagePath
    ];
    for (const c of candidates) {
        const s = String(c || '').trim();
        if (s) return s;
    }
    return '';
};

const extractPreviewFileName = (preview: any): string => {
    const named = String(preview?.fileName || '').trim();
    if (named) return named;
    const fromPath = fileNameFromPath(extractPreviewFilePath(preview));
    if (fromPath) return fromPath;
    return '';
};

const ensureTftImageCacheAliases = (preview: any): void => {
    if (typeof window === 'undefined') return;
    const cache = rawTftImageCache();
    const filePath = extractPreviewFilePath(preview);
    const fileName = extractPreviewFileName(preview);
    if (!filePath && !fileName) return;

    const keys = [filePath, fileName, fileName.toLowerCase()].filter(Boolean);
    let hit: any = null;
    for (const k of keys) {
        if (cache[k]) {
            hit = cache[k];
            break;
        }
    }
    if (!hit) return;
    touchManagedTftImageEntry(hit as ManagedTftImageCacheEntry);

    for (const k of keys) {
        if (!cache[k]) {
            cache[k] = hit;
            const managed = hit as ManagedTftImageCacheEntry;
            if (managed.__ckAliases && !managed.__ckAliases.includes(k)) {
                managed.__ckAliases.push(k);
            }
        }
    }
};

const ensureTftImageCacheFromPreview = (preview: any): void => {
    if (typeof window === 'undefined') return;
    const imageData = String(preview?.imageData || '').trim();
    if (!imageData || !imageData.startsWith('data:image/')) return;

    const cache = rawTftImageCache();
    const filePath = extractPreviewFilePath(preview);
    const fileName = extractPreviewFileName(preview);
    const dims = extractPreviewDims(preview);
    const keys = [filePath, fileName, fileName.toLowerCase()].filter(Boolean);
    if (!keys.length) return;

    for (const k of keys) {
        if (cache[k]) return;
    }

    const img = new Image();
    const cachePath = filePath || fileName;
    img.onload = () => {
        try {
            cacheTftImageElement(cachePath, img, imageData.length, fileName || filePath);
        } catch (error) {
            console.warn('[Extensions] Restored TFT image exceeded the cache budget:', error);
            releaseTftImageCachePath(cachePath, fileName || filePath);
        }
    };
    img.src = imageData;
    try {
        cacheTftImageElement(cachePath, img, imageData.length, fileName || filePath);
    } catch (error) {
        console.warn('[Extensions] TFT image preview was not cached:', error);
    }
};

const syncTftImageBlockSizeFromPreview = (block: any, preview: any): void => {
    let { width: pw, height: ph } = extractPreviewDims(preview);
    if ((!pw || !ph) && typeof window !== 'undefined') {
        const cache = rawTftImageCache();
        const filePath = extractPreviewFilePath(preview);
        const fileName = extractPreviewFileName(preview);
        const hit = cache[filePath] || cache[fileName] || cache[String(fileName || '').toLowerCase()];
        if (hit) touchManagedTftImageEntry(hit);
        pw = pw || Number(hit?.originalWidth || hit?.width || 0);
        ph = ph || Number(hit?.originalHeight || hit?.height || 0);
    }
    if (!Number.isFinite(pw) || !Number.isFinite(ph) || pw <= 0 || ph <= 0) return;

    const currentW = Number(block?.getFieldValue?.('WIDTH') || 0);
    const currentH = Number(block?.getFieldValue?.('HEIGHT') || 0);
    const shouldSync = !currentW || !currentH || (currentW === 32 && currentH === 32);
    if (!shouldSync) return;

    try {
        const wField = block?.getField?.('WIDTH');
        const hField = block?.getField?.('HEIGHT');
        if (wField && typeof wField.setValue === 'function') wField.setValue(String(Math.round(pw)));
        if (hField && typeof hField.setValue === 'function') hField.setValue(String(Math.round(ph)));
    } catch { }
};

const wrapTftImageFileGenerator = (extId: string) => {
    const forBlock = (arduinoGenerator as any)?.forBlock;
    if (!forBlock || typeof forBlock !== 'object') return;
    const original = forBlock['tft_image_file'];
    if (typeof original !== 'function') return;
    if ((original as any).__ckTftImageWrapped) return;

    const wrapped = function (this: any, ...args: any[]) {
        const block = args?.[0];
        let preview: any = null;

        if (block && typeof block.getFieldValue === 'function') {
            try {
                preview = readImagePreviewFromBlock(block);
                if (preview) {
                    ensureTftImageCacheFromPreview(preview);
                    ensureTftImageCacheAliases(preview);
                    syncTftImageBlockSizeFromPreview(block, preview);
                }
            } catch (e) {
                console.warn(`[Extensions] tft_image_file pre-normalization skipped for ${extId}:`, e);
            }
        }

        if (preview && block && typeof block === 'object') {
            const patchedBlock = new Proxy(block, {
                get(target: any, prop: string | symbol, receiver: any) {
                    if (prop === 'getFieldValue') {
                        return (fieldName: string) => {
                            if (fieldName === 'IMAGE_PREVIEW') {
                                return (typeof preview === 'string') ? preview : JSON.stringify(preview);
                            }
                            const fn = target?.getFieldValue;
                            return (typeof fn === 'function') ? fn.call(target, fieldName) : undefined;
                        };
                    }
                    const val = Reflect.get(target, prop, receiver);
                    if (typeof val === 'function') return val.bind(target);
                    return val;
                }
            });
            return original.apply(this, [patchedBlock, ...args.slice(1)]);
        }

        return original.apply(this, args);
    };
    (wrapped as any).__ckTftImageWrapped = true;
    (wrapped as any).__ckOriginal = original;
    forBlock['tft_image_file'] = wrapped;
    console.log(`[Extensions] Applied tft_image_file runtime compatibility wrapper for ${extId}`);
};

/**
 * 閫氳繃鍚庣鐨?IPC 鎺ュ彛鑾峰彇鏈湴鎵€鏈夌鍚堟爣鍑嗙殑绗笁鏂规墿灞?
 * @param fqbn 鍙€夛紝褰撳墠娲诲姩寮€鍙戞澘 FQBN锛岀敤浜庢寜鏉胯繃婊ゆ墿灞?
 */
export async function getAvailableExtensions(fqbn?: string): Promise<ExtensionInfo[]> {
    try {
        const exts: ExtensionInfo[] = await invoke('get_available_extensions', { fqbn: fqbn || null });
        const sorted = [...exts].sort((a, b) => {
            const scoreDiff = extensionPriorityScore(a.id) - extensionPriorityScore(b.id);
            if (scoreDiff !== 0) return scoreDiff;
            return String(a.id || '').localeCompare(String(b.id || ''));
        });
        console.log("[Extensions] Found extensions:", sorted);
        return sorted;
    } catch (e) {
        console.error("[Extensions] Failed to get extensions:", e);
        return [];
    }
}

const readTextOrNull = async (path: string): Promise<string | null> => {
    try {
        return await readTextFileCached(path);
    } catch {
        return null;
    }
};

const resolveLegacyToolboxXmlPath = async (ext: ExtensionInfo): Promise<string | null> => {
    const directCandidates = [
        ext.toolbox_path,
        `${ext.dir_path}/toolbox.xml`,
        `${ext.dir_path}/blocks/toolbox.xml`
    ].filter((candidate): candidate is string => Boolean(candidate));
    for (const candidate of directCandidates) {
        const content = await readTextOrNull(candidate);
        if (content && /<\s*(xml|category)\b/i.test(content)) return candidate;
    }

    try {
        const entries: any[] = await readDir(ext.dir_path);
        const xmlFiles = entries
            .filter((entry: any) => !entry?.isDirectory && /\.xml$/i.test(String(entry?.name || '')))
            .sort((a: any, b: any) => String(a?.name || '').localeCompare(String(b?.name || '')));
        for (const entry of xmlFiles) {
            const candidate = `${ext.dir_path}/${entry.name}`;
            const content = await readTextOrNull(candidate);
            if (content && /<\s*(xml|category)\b/i.test(content)) return candidate;
        }
    } catch {
        // ignore
    }

    return null;
};

const normalizePathSegments = (rawPath: string, absolute: boolean): string => {
    const hadTrailingSlash = /\/$/.test(rawPath);
    const parts = String(rawPath || '').split('/');
    const out: string[] = [];
    for (const part of parts) {
        if (!part || part === '.') continue;
        if (part === '..') {
            if (out.length > 0 && out[out.length - 1] !== '..') {
                out.pop();
            } else if (!absolute) {
                out.push(part);
            }
            continue;
        }
        out.push(part);
    }
    let normalized = out.join('/');
    if (absolute) normalized = '/' + normalized;
    if (hadTrailingSlash && normalized && normalized !== '/') normalized += '/';
    if (!normalized) normalized = absolute ? '/' : '';
    return normalized;
};

const normalizeCompatPath = (raw: any): string => {
    let value = String(raw ?? '').trim();
    if (!value) return '';
    value = value.replace(/\\/g, '/');

    const protoMatch = value.match(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^/]*)(\/.*)?$/);
    if (protoMatch) {
        const proto = protoMatch[1];
        const host = protoMatch[2] || '';
        const pathPart = protoMatch[3] || '/';
        return `${proto}${host}${normalizePathSegments(pathPart, true)}`;
    }

    if (/^[a-zA-Z]:\//.test(value)) {
        const drive = value.slice(0, 2);
        const pathPart = value.slice(2) || '/';
        return `${drive}${normalizePathSegments(pathPart, true)}`;
    }

    if (value.startsWith('/')) {
        return normalizePathSegments(value, true);
    }
    return normalizePathSegments(value, false);
};

const decodeFileUrlToPath = (urlText: string): string => {
    const raw = String(urlText || '').trim();
    if (!/^file:\/\//i.test(raw)) return raw;
    let out = raw.replace(/^file:\/\//i, '');
    try {
        out = decodeURIComponent(out);
    } catch {
        // keep raw value
    }
    if (/^\/[a-zA-Z]:\//.test(out)) {
        out = out.slice(1);
    }
    return normalizeCompatPath(out);
};

const isLikelyLocalFsPath = (value: string): boolean => {
    const text = String(value || '').trim();
    if (!text) return false;
    if (/^(https?:|data:|blob:|tauri:|asset:|app:|about:|chrome:|mailto:)/i.test(text)) {
        return false;
    }
    if (/^file:\/\//i.test(text)) return true;
    if (/^[a-zA-Z]:[\\/]/.test(text)) return true;
    if (/^[a-zA-Z]:\//.test(text)) return true;
    if (/^\/(Users|home|opt|var|tmp|etc)\//.test(text)) return true;
    if (/^\\\\/.test(text)) return true;
    return false;
};

const toCompatImageSrc = (raw: any): any => {
    if (raw === null || typeof raw === 'undefined') return raw;
    const text = String(raw || '').trim();
    if (!text) return text;

    const normalizedInput = /^file:\/\//i.test(text)
        ? decodeFileUrlToPath(text)
        : normalizeCompatPath(text);

    if (!isLikelyLocalFsPath(normalizedInput)) {
        return normalizedInput;
    }

    try {
        const filePath = /^file:\/\//i.test(normalizedInput)
            ? decodeFileUrlToPath(normalizedInput)
            : normalizedInput;
        return convertFileSrc(filePath);
    } catch {
        return normalizedInput;
    }
};

const ensureFieldImageCompat = (blocklyApi: any): void => {
    const targetBlockly = blocklyApi || (Blockly as any);
    const OriginalFieldImage = targetBlockly?.FieldImage || (Blockly as any)?.FieldImage;
    if (!OriginalFieldImage || (OriginalFieldImage as any).__ckCompatImageSrcWrapped) return;

    class FieldImageCompat extends OriginalFieldImage {
        constructor(src: any, width?: any, height?: any, alt?: any, onClick?: any, flipRtl?: any) {
            super(toCompatImageSrc(src), width, height, alt, onClick, flipRtl);
        }
        setValue(newValue: any) {
            if (typeof super.setValue === 'function') {
                return super.setValue(toCompatImageSrc(newValue));
            }
            return undefined;
        }
        static fromJson(options: any) {
            const normalized = options && typeof options === 'object'
                ? { ...options, src: toCompatImageSrc((options as any).src) }
                : options;
            const parentFromJson = (OriginalFieldImage as any).fromJson;
            if (typeof parentFromJson === 'function') {
                return parentFromJson.call(this, normalized);
            }
            return new FieldImageCompat(
                normalized?.src,
                normalized?.width,
                normalized?.height,
                normalized?.alt,
                normalized?.onClick,
                normalized?.flipRtl
            );
        }
    }

    (FieldImageCompat as any).__ckCompatImageSrcWrapped = true;
    try {
        targetBlockly.FieldImage = FieldImageCompat;
    } catch {
        // ignore assignment failures
    }
    try {
        const globalBlockly = (globalThis as any)?.Blockly;
        if (globalBlockly && typeof globalBlockly === 'object') {
            globalBlockly.FieldImage = FieldImageCompat;
        }
    } catch {
        // ignore assignment failures
    }
};

const createLegacyFallbackBlockDefinition = (type: string, extId: string): any => ({
    init: function () {
        this.appendDummyInput().appendField(`[${type}]`);
        this.setColour(180);
        this.setTooltip(`兼容回退积木 (${extId}): ${type}`);
        this.setHelpUrl('');
    }
});

const applyLegacySafeBlockDefinition = (type: string, rawDef: any, extId: string): any => {
    if (!rawDef || typeof rawDef !== 'object') {
        return createLegacyFallbackBlockDefinition(type, extId);
    }
    if (typeof rawDef.init !== 'function') {
        return createLegacyFallbackBlockDefinition(type, extId);
    }

    const def = rawDef as any;
    if (!def.__ckLegacyInitSafeWrapped) {
        const originalInit = def.init;
        def.init = function (...args: any[]) {
            try {
                return originalInit.apply(this, args);
            } catch (err) {
                console.warn(`[Extensions] Block init fallback for ${type} in ${extId}:`, err);
                try {
                    if (Array.isArray((this as any).inputList)) {
                        const names = (this as any).inputList.map((input: any) => String(input?.name || '')).filter(Boolean);
                        for (const name of names) {
                            try { (this as any).removeInput(name); } catch { }
                        }
                    }
                    (this as any).appendDummyInput?.().appendField(`[${type}]`);
                    (this as any).setColour?.(180);
                    (this as any).setTooltip?.(`兼容回退积木 (${extId}): ${type}`);
                    (this as any).setHelpUrl?.('');
                } catch {
                    // ignore
                }
            }
        };
        def.__ckLegacyInitSafeWrapped = true;
    }

    if (typeof def.onchange === 'function' && !def.__ckLegacyOnChangeSafeWrapped) {
        const originalOnChange = def.onchange;
        def.onchange = function (...args: any[]) {
            try {
                return originalOnChange.apply(this, args);
            } catch (err) {
                console.warn(`[Extensions] Block onchange fallback for ${type} in ${extId}:`, err);
                return;
            }
        };
        def.__ckLegacyOnChangeSafeWrapped = true;
    }

    return def;
};

const applyLegacyExtensionVisualColour = (blocklyApi: any, extId: string, visualColour?: string): void => {
    if (!visualColour) return;
    const blocksObj = blocklyApi?.Blocks || (Blockly as any)?.Blocks;
    if (!blocksObj || typeof blocksObj !== 'object') return;

    for (const [type, owner] of extensionBlockOwners.entries()) {
        if (owner !== extId || isProtectedCoreBlockType(type)) continue;
        extensionBlockVisualColours.set(type, visualColour);
        const definition = blocksObj[type];
        if (!definition || typeof definition.init !== 'function') continue;

        definition.__ckExtensionVisualColour = visualColour;
        if (definition.__ckExtensionVisualColourWrapped) continue;

        const originalInit = definition.init;
        definition.init = function (...args: any[]) {
            const result = originalInit.apply(this, args);
            try {
                (this as any).setColour?.(definition.__ckExtensionVisualColour);
            } catch {
                // Keep the extension usable if a legacy block rejects colour updates.
            }
            return result;
        };
        definition.__ckExtensionVisualColourWrapped = true;
    }
};

let runtimeNewBlockGuardInstalled = false;
const ensureRuntimeNewBlockGuard = (blocklyApi: any): void => {
    if (runtimeNewBlockGuardInstalled) return;

    const applyRuntimeVisualColour = (block: any, rawType?: any) => {
        const type = String(rawType || block?.type || '').trim();
        const visualColour = extensionBlockVisualColours.get(type);
        if (!visualColour || isProtectedCoreBlockType(type)) return;
        try { block?.setColour?.(visualColour); } catch { }
    };

    const patchPrototype = (proto: any): boolean => {
        if (!proto || typeof proto.newBlock !== 'function' || proto.__ckExtensionVisualColourNewBlockPatched) {
            return false;
        }
        const originalNewBlock = proto.newBlock;
        proto.newBlock = function (type: any, id?: string) {
            const normalizedType = normalizeLegacyToolboxBlockType(type);
            const safeType = String(normalizedType || type || '').trim();
            if (safeType) {
                const blocksObj = blocklyApi?.Blocks || (Blockly as any)?.Blocks;
                if (blocksObj && typeof blocksObj === 'object') {
                    if (isProtectedCoreBlockType(safeType) && CORE_BLOCK_IMPLS.has(safeType)) {
                        blocksObj[safeType] = CORE_BLOCK_IMPLS.get(safeType);
                    } else {
                        const current = blocksObj[safeType];
                        const safeDef = applyLegacySafeBlockDefinition(
                            safeType,
                            current,
                            extensionBlockOwners.get(safeType) || 'runtime'
                        );
                        if (safeDef && safeDef !== current) {
                            blocksObj[safeType] = safeDef;
                        } else if (!current && safeDef) {
                            blocksObj[safeType] = safeDef;
                        }
                    }
                }
            }
            const block = originalNewBlock.call(this, safeType || type, id);
            applyRuntimeVisualColour(block, safeType);
            return block;
        };
        proto.__ckSafeNewBlockPatched = true;
        proto.__ckExtensionVisualColourNewBlockPatched = true;
        return true;
    };

    const patchBlockSvgInit = (proto: any): boolean => {
        if (!proto || typeof proto.initSvg !== 'function' || proto.__ckExtensionVisualColourInitSvgPatched) {
            return false;
        }
        const originalInitSvg = proto.initSvg;
        proto.initSvg = function (...args: any[]) {
            const result = originalInitSvg.apply(this, args);
            applyRuntimeVisualColour(this);
            return result;
        };
        proto.__ckExtensionVisualColourInitSvgPatched = true;
        return true;
    };

    const patchedWorkspaceSvg = patchPrototype(blocklyApi?.WorkspaceSvg?.prototype);
    const patchedWorkspace = patchPrototype(blocklyApi?.Workspace?.prototype);
    const patchedBlockSvg = patchBlockSvgInit(blocklyApi?.BlockSvg?.prototype);
    runtimeNewBlockGuardInstalled = patchedWorkspaceSvg || patchedWorkspace || patchedBlockSvg;
};

export async function registerExtensionBlocks(
    ext: ExtensionInfo,
    blocklyNs?: any,
    visualColour?: string,
    boardIdentity?: BoardPinDropdownIdentity,
) {
    try {
        ensureCoreBlockSnapshot(resolveBlocklyApi(blocklyNs));
        const configuredBlocksPath = String(ext.blocks_path || '').replace(/\\/g, '/');
        if (configuredBlocksPath && !isSafeDeclarativeEntrypoint(configuredBlocksPath, 'blocks')) {
            throw new Error(
                `Executable block entrypoint is disabled for ${ext.id}: ${configuredBlocksPath}. `
                + 'Provide a JSON block definition file.',
            );
        }
        const blockJsonPath = configuredBlocksPath || `${ext.dir_path}/block.json`;
        const blockJsonStrRaw = await readTextFileCached(blockJsonPath);
        let preserveDropdownFields = compatValidatorFieldNamesByExtension.get(ext.id);
        if (!preserveDropdownFields) {
            preserveDropdownFields = new Set<string>();
            compatValidatorFieldNamesByExtension.set(ext.id, preserveDropdownFields);
        }

        // Resolve templates against the exact compiler target + CK package id.
        // Missing identity or missing custom-board pins stays an explicit
        // sentinel and never borrows the historical Arduino Uno list.
        const initialIdentity = boardIdentity;
        const blockJson = bindDynamicBoardPinTemplates(
            parseDeclarativeBlockDocument(blockJsonStrRaw),
            capability => {
                const activeIdentity = BOARD_PIN_DROPDOWN_REGISTRY.getActiveIdentity();
                const identity = activeIdentity.fqbn ? activeIdentity : initialIdentity;
                if (!identity?.fqbn) {
                    return [[UNDECLARED_BOARD_PIN[0], UNDECLARED_BOARD_PIN[1]]];
                }
                return BOARD_PIN_DROPDOWN_REGISTRY.resolveCapability(
                    identity,
                    capability,
                    getPinsAsDropdown(identity.fqbn),
                );
            },
        );
        const blocklyApi = resolveBlocklyApi(blocklyNs);
        ensureFieldImageCompat(blocklyApi);
        restoreProtectedCoreBlocks(blocklyApi);
        registerImagePreviewFieldCompat(blocklyApi);
        const blockDefs = normalizeBlockDefs(blockJson, blocklyApi, preserveDropdownFields, visualColour);
        registerCompatShadowGenerators(blockDefs);

        if (!blockDefs.length) {
            throw new Error(`block.json has no valid block definitions for ${ext.id}`);
        }

        const defineBlocks = blocklyApi?.defineBlocksWithJsonArray || blocklyApi?.common?.defineBlocksWithJsonArray;

        // Auto-register any undefined Block extensions or mutators (e.g., custom UI hooks specified in JSON).
        // Try a generator-first pass before falling back to dummy stubs.
        if (Array.isArray(blockDefs) && blocklyApi?.Extensions) {
            const depsToStub = new Set<string>();
            for (const block of blockDefs) {
                if (Array.isArray(block?.extensions)) {
                    for (const dep of block.extensions) {
                        if (typeof dep === 'string' && dep.trim()) depsToStub.add(dep.trim());
                    }
                }
                if (typeof block?.mutator === 'string' && block.mutator.trim()) {
                    depsToStub.add(block.mutator.trim());
                }
            }

            const isRegistered = (name: string): boolean => {
                try {
                    if (typeof blocklyApi.Extensions?.isRegistered === 'function') {
                        return !!blocklyApi.Extensions.isRegistered(name);
                    }
                } catch { }
                return false;
            };

            for (const extName of depsToStub) {
                if (isRegistered(extName)) continue;
                console.warn(`[Extensions] Pre-registering dummy fallback block extension/mutator: ${extName}`);

                if (extName.includes('mutator')) {
                    blocklyApi.Extensions.registerMutator(extName, {
                        domToMutation: function () { },
                        mutationToDom: function () { return document.createElement('mutation'); }
                    });
                } else {
                    blocklyApi.Extensions.register(extName, function () { /* fallback noop */ });
                }
            }
        }

        // Refresh extension block definitions on each load so compatibility fixes
        // can recover from previously-registered broken schemas in the same session.
        const blocksObj = blocklyApi?.Blocks || Blockly.Blocks || {};
        const newBlockDefs = blockDefs
            .filter(def => !!def?.type)
            .filter((def) => {
                const type = String(def?.type || '').trim();
                if (!type) return false;

                if (isProtectedCoreBlockType(type)) {
                    console.warn(`[Extensions] Skipping protected core block override: ${type} (extension: ${ext.id})`);
                    return false;
                }

                const owner = extensionBlockOwners.get(type);
                if (owner && owner !== ext.id && !isCompatShadowType(type)) {
                    if (!shouldPreferCandidateOwner(owner, ext.id)) {
                        const conflictMsg = `[Extensions] Skipping block type conflict "${type}" from ${ext.id}; owned by ${owner}`;
                        console.warn(conflictMsg);
                        return false;
                    }
                    const replaceMsg = `[Extensions] Replacing block type owner "${type}" from ${owner} -> ${ext.id}`;
                    console.warn(replaceMsg);
                }

                return true;
            });

        if (!newBlockDefs.length) {
            console.warn(`[Extensions] No safe block definitions to register for ${ext.id}`);
            return;
        }

        const previousBlockDefs = new Map<string, any>();
        for (const def of newBlockDefs) {
            if (blocksObj[def.type]) {
                previousBlockDefs.set(def.type, blocksObj[def.type]);
                delete blocksObj[def.type];
            }
        }

        const restorePreviousBlockDefs = () => {
            for (const def of newBlockDefs) {
                const type = String(def?.type || '').trim();
                if (!type) continue;
                if (previousBlockDefs.has(type)) {
                    blocksObj[type] = previousBlockDefs.get(type);
                } else if (blocksObj[type]) {
                    delete blocksObj[type];
                }
            }
        };

        const ensureDefsExist = (defs: any[]): any[] => {
            return defs.filter((def) => {
                const type = String(def?.type || '').trim();
                return !!type && !blocksObj[type];
            });
        };

        let registrationSucceeded = false;
        if (typeof defineBlocks === 'function') {
            try {
                defineBlocks.call(blocklyApi, newBlockDefs);
                const missingAfterDefine = ensureDefsExist(newBlockDefs);
                if (missingAfterDefine.length > 0) {
                    const fallbackRegistered = fallbackRegisterBlocks(blocklyApi, missingAfterDefine);
                    if (fallbackRegistered > 0) {
                        console.warn(
                            `[Extensions] Applied fallback registration for ${fallbackRegistered}/${missingAfterDefine.length} missing blocks in ${ext.id}.`
                        );
                    }
                }
                registrationSucceeded = ensureDefsExist(newBlockDefs).length === 0;
            } catch (e) {
                console.warn(`[Extensions] defineBlocks warning for ${ext.id}:`, e);
                const fallbackRegistered = fallbackRegisterBlocks(blocklyApi, newBlockDefs);
                registrationSucceeded = fallbackRegistered > 0;
                if (registrationSucceeded) {
                    console.warn(
                        `[Extensions] Recovered from defineBlocks failure with fallback registration for ${fallbackRegistered} blocks in ${ext.id}.`
                    );
                }
            }
        } else {
            const registered = fallbackRegisterBlocks(blocklyApi, newBlockDefs);
            if (!registered) {
                restorePreviousBlockDefs();
                throw new Error('No Blockly block registration API available');
            }
            registrationSucceeded = true;
            console.warn(`[Extensions] defineBlocksWithJsonArray missing, used fallback registration for ${registered} blocks in ${ext.id}`);
        }

        if (!registrationSucceeded) {
            restorePreviousBlockDefs();
            throw new Error(`Failed to register block definitions for ${ext.id}`);
        }

        for (const def of newBlockDefs) {
            const type = String(def?.type || '').trim();
            if (!type || isCompatShadowType(type)) continue;
            extensionBlockOwners.set(type, ext.id);
            if (visualColour) extensionBlockVisualColours.set(type, visualColour);
        }

        console.log(`[Extensions] Registered blocks for ${ext.id}`);
    } catch (error) {
        console.error(`[Extensions ${EXT_LOADER_RUNTIME_REV}] Rejected extension blocks for ${ext.id}:`, error);
        throw error;
    }
}

/**
 * 注册给定扩展的声明式 ck-generator JSON 规则。
 */
export async function registerExtensionGenerator(ext: ExtensionInfo, blocklyNs?: any) {
    if (!ext.has_generator) return;
    const configuredGeneratorPath = String(ext.generator_path || '').replace(/\\/g, '/');
    if (configuredGeneratorPath && !isSafeDeclarativeEntrypoint(configuredGeneratorPath, 'generator')) {
        throw new Error(
            `Executable generator entrypoint is disabled for ${ext.id}: ${configuredGeneratorPath}. `
            + 'Provide a ck-generator JSON document.',
        );
    }
    const declarativePath = configuredGeneratorPath || `${ext.dir_path}/ck-generator.json`;
    const declarativeSource = await readTextFileCached(declarativePath);
    const document = parseDeclarativeGeneratorDocument(declarativeSource);
    const blocklyApi = resolveBlocklyApi(blocklyNs);
    ensureFieldImageCompat(blocklyApi);
    const beforeForBlockMap = new Map<string, any>();
    const forBlockObj = ((arduinoGenerator as any)?.forBlock || {}) as Record<string, any>;
    for (const [key, value] of Object.entries(forBlockObj)) beforeForBlockMap.set(key, value);

    let registered = 0;
    for (const rule of document.rules) {
        if (isProtectedCoreBlockType(rule.type)) {
            throw new Error(`ck-generator may not override protected core block type: ${rule.type}`);
        }
        const blockOwner = extensionBlockOwners.get(rule.type);
        if (blockOwner !== ext.id) {
            throw new Error(
                `ck-generator rule ${rule.type} has no block definition owned by ${ext.id}`,
            );
        }
        const generatorOwner = extensionGeneratorOwners.get(rule.type);
        if (generatorOwner && generatorOwner !== ext.id
            && !shouldPreferCandidateOwner(generatorOwner, ext.id)) {
            console.warn(
                `[Extensions] Skipping declarative generator conflict "${rule.type}" from ${ext.id}; owned by ${generatorOwner}`,
            );
            continue;
        }
        forBlockObj[rule.type] = bindDeclarativeGeneratorFunction(rule, arduinoGenerator);
        extensionGeneratorOwners.set(rule.type, ext.id);
        registered++;
    }
    if (registered !== document.rules.length) {
        throw new Error(`Only ${registered}/${document.rules.length} ck-generator rules were registered`);
    }
    wrapExtensionForBlockGenerators(ext.id, beforeForBlockMap);
    console.log(`[Extensions] Registered ${registered} declarative generator rule(s) for ${ext.id}`);
}

const replaceInXmlBlockSegments = (
    xml: string,
    blockType: string,
    replacer: (segment: string) => string
): string => {
    const source = String(xml || '');
    if (!source) return source;
    const tagRe = /<\/?block\b[^>]*>/gi;
    const typeRe = /\btype=(["'])([^"']+)\1/i;
    const stack: Array<{ type: string; start: number }> = [];
    const segments: Array<{ start: number; end: number }> = [];
    let match: RegExpExecArray | null;

    while ((match = tagRe.exec(source)) !== null) {
        const tag = match[0];
        const isClose = tag.startsWith('</');
        if (!isClose) {
            const typeMatch = tag.match(typeRe);
            stack.push({
                type: typeMatch?.[2] || '',
                start: match.index,
            });
            continue;
        }
        const opened = stack.pop();
        if (!opened) continue;
        if (opened.type === blockType) {
            segments.push({ start: opened.start, end: tagRe.lastIndex });
        }
    }

    if (segments.length === 0) return source;
    let out = source;
    segments
        .sort((a, b) => b.start - a.start)
        .forEach(({ start, end }) => {
            const seg = out.slice(start, end);
            const replaced = replacer(seg);
            out = out.slice(0, start) + replaced + out.slice(end);
        });
    return out;
};

const LEGACY_TOOLBOX_BLOCK_TYPE_ALIASES: Record<string, string> = {
    arduino_setup: 'controls_setup_custom',
    base_setup: 'controls_setup_custom',
    arduino_loop: 'controls_loop_custom',
    base_loop: 'controls_loop_custom',
    serial_begin: 'serial_setup',
    serial_println: 'serial_print',
    text_char: 'text_char_literal_custom',
};

const normalizeLegacyToolboxBlockType = (rawType: any): string => {
    const type = String(rawType || '').trim();
    if (!type) return '';
    return LEGACY_TOOLBOX_BLOCK_TYPE_ALIASES[type] || type;
};

const ensureToolboxFallbackBlocksForTypes = (
    rawTypes: Iterable<string>,
    extId: string,
    blocklyApi?: any
): number => {
    const blocksObj = blocklyApi?.Blocks || (Blockly as any)?.Blocks;
    if (!blocksObj || typeof blocksObj !== 'object') return 0;
    ensureCoreBlockSnapshot(blocklyApi);
    let created = 0;

    for (const rawType of rawTypes) {
        const normalized = normalizeLegacyToolboxBlockType(rawType);
        if (!normalized || isCompatShadowType(normalized)) continue;

        if (isProtectedCoreBlockType(normalized) && CORE_BLOCK_IMPLS.has(normalized)) {
            blocksObj[normalized] = CORE_BLOCK_IMPLS.get(normalized);
            continue;
        }

        const current = blocksObj[normalized];
        if (!current) {
            // Prefer waiting for real block registrations from legacy scripts
            // instead of forcing placeholder-only flyout entries.
            continue;
        }
        const hardened = applyLegacySafeBlockDefinition(normalized, current, extId);
        if (hardened !== current || typeof hardened?.init !== 'function') {
            blocksObj[normalized] = hardened;
            created++;
        } else {
            blocksObj[normalized] = hardened;
        }

        if (!isProtectedCoreBlockType(normalized) && !extensionBlockOwners.has(normalized)) {
            extensionBlockOwners.set(normalized, extId);
        }
    }

    return created;
};

const ensureToolboxFallbackBlocksFromXml = (xml: string, extId: string, blocklyApi?: any): number => {
    const source = String(xml || '');
    if (!source) return 0;
    const types = new Set<string>();
    const re = /<block\b[^>]*\btype=(['"])([^'"]+)\1/gi;
    let m: RegExpExecArray | null = null;
    while ((m = re.exec(source)) !== null) {
        const t = String(m[2] || '').trim();
        if (t) types.add(t);
    }
    return ensureToolboxFallbackBlocksForTypes(types, extId, blocklyApi);
};

const ensureToolboxFallbackBlocksFromJson = (toolboxJson: any, extId: string, blocklyApi?: any): number => {
    const types = new Set<string>();
    const walk = (node: any) => {
        if (!node) return;
        if (Array.isArray(node)) {
            node.forEach((item) => walk(item));
            return;
        }
        if (typeof node !== 'object') return;

        if (String(node.kind || '').toLowerCase() === 'block' && node.type) {
            types.add(String(node.type));
        }

        if (node.block && typeof node.block === 'object' && node.block.type) {
            types.add(String(node.block.type));
        }
        if (node.shadow && typeof node.shadow === 'object' && node.shadow.type) {
            types.add(String(node.shadow.type));
        }

        if (node.inputs && typeof node.inputs === 'object') {
            for (const inputValue of Object.values(node.inputs)) {
                walk(inputValue);
            }
        }

        if (Array.isArray(node.contents)) {
            node.contents.forEach((item: any) => walk(item));
        }
    };
    walk(toolboxJson);
    return ensureToolboxFallbackBlocksForTypes(types, extId, blocklyApi);
};

// Map Mixly/legacy Blockly integer hue values (0-360) to CK design-system hex colors.
// This prevents garish Mixly colors (e.g. hue=330 → hot-pink) from appearing in the toolbox.
const normalizeLegacyHueColour = (colourVal: string): string => {
    const val = String(colourVal || '').trim();
    if (!val || val.startsWith('#')) return val; // already hex — keep
    const hue = parseInt(val, 10);
    if (!isFinite(hue) || hue < 0 || hue > 360) return val;
    // Map hue ranges to CK palette constants (matching blockly_setup.ts HUE values)
    if (hue >= 320 || hue < 20)  return '#C026D3'; // pink/red   → variable purple
    if (hue < 70)                return '#F59E0B'; // yellow-orange → amber/time
    if (hue < 100)               return '#65A30D'; // yellow-green  → math lime
    if (hue < 160)               return '#22C55E'; // green         → loop green
    if (hue < 200)               return '#14B8A6'; // teal          → text teal
    if (hue < 250)               return '#2563EB'; // blue          → serial/logic blue
    if (hue < 320)               return '#7C3AED'; // purple        → array violet
    return '#65A30D';
};

const applyExtensionFallbackColourToToolboxXml = (rawXml: string, visualColour?: string): string => {
    if (!visualColour) return rawXml;
    return String(rawXml || '').replace(/<category\b([^>]*)>/gi, (full, rawAttrs: string) => {
        const colourMatch = rawAttrs.match(/\b(?:colour|color)\s*=\s*(['"])(.*?)\1/i);
        if (colourMatch && hasExplicitVisualColour(colourMatch[2])) return full;

        if (colourMatch) {
            const nextAttrs = rawAttrs.replace(colourMatch[0], `colour="${visualColour}"`);
            return `<category${nextAttrs}>`;
        }
        return `<category${rawAttrs} colour="${visualColour}">`;
    });
};

const normalizeLegacyToolboxXml = (rawXml: string): string => {
    let out = String(rawXml || '').replace(/^\uFEFF/, '');

    // Normalize all colour= attributes: convert integer Mixly hues to CK palette hex.
    out = out.replace(/\bcolour=(['"])(\d+)\1/g, (_m, q, hue) =>
        `colour=${q}${normalizeLegacyHueColour(hue)}${q}`
    );

    const rewriteBlockType = (xml: string, legacyType: string, targetType: string): string => {
        return String(xml || '').replace(
            new RegExp(`type=(['"])${legacyType}\\1`, 'gi'),
            (_m, quote: string) => `type=${quote}${targetType}${quote}`
        );
    };

    for (const [legacyType, targetType] of Object.entries(LEGACY_TOOLBOX_BLOCK_TYPE_ALIASES)) {
        out = rewriteBlockType(out, legacyType, targetType);
    }

    out = replaceInXmlBlockSegments(out, 'serial_print', (seg) => {
        let normalized = seg;
        normalized = normalized.replace(/<field\s+name="serial_select">[\s\S]*?<\/field>/gi, '');
        normalized = normalized.replace(/<field\s+name="new_line">\s*println\s*<\/field>/gi, '<field name="NEWLINE">TRUE</field>');
        normalized = normalized.replace(/<field\s+name="new_line">\s*print\s*<\/field>/gi, '<field name="NEWLINE">FALSE</field>');
        normalized = normalized.replace(/<field\s+name="new_line">/gi, '<field name="NEWLINE">');
        normalized = normalized
            .replace(/<value\s+name="CONTENT">/gi, '<value name="MSG">')
            .replace(/<value\s+name="VALUE">/gi, '<value name="MSG">')
            .replace(/<value\s+name="TEXT">/gi, '<value name="MSG">');
        return normalized;
    });

    out = replaceInXmlBlockSegments(out, 'serial_setup', (seg) => {
        let normalized = seg;
        normalized = normalized.replace(/<field\s+name="serial_select">[\s\S]*?<\/field>/gi, '');
        normalized = normalized
            .replace(/<value\s+name="CONTENT">/gi, '<value name="BAUD">')
            .replace(/<value\s+name="VALUE">/gi, '<value name="BAUD">')
            .replace(/<value\s+name="baud_rate">/gi, '<value name="BAUD">');
        return normalized;
    });

    out = replaceInXmlBlockSegments(out, 'controls_delay', (seg) => {
        let normalized = seg;
        normalized = normalized.replace(/<field\s+name="UNIT">\s*(?:ms|millis|delay)\s*<\/field>/gi, '<field name="UNIT">delay</field>');
        normalized = normalized.replace(/<field\s+name="UNIT">\s*(?:us|micros|microseconds|delaymicroseconds)\s*<\/field>/gi, '<field name="UNIT">delayMicroseconds</field>');
        if (!/<value\s+name="DELAY_TIME">/i.test(normalized)) {
            normalized = normalized.replace(
                /<field\s+name="(?:DELAY_TIME|TIME)">\s*([+\-]?(?:\d+(?:\.\d+)?|\.\d+))\s*<\/field>/i,
                '<value name="DELAY_TIME"><shadow type="math_number"><field name="NUM">$1</field></shadow></value>'
            );
        }
        return normalized;
    });

    out = replaceInXmlBlockSegments(out, 'text_join', (seg) => {
        return seg.replace(/<value\s+name="([A-Z])">/g, (_m, letter: string) => {
            const idx = letter.charCodeAt(0) - 65;
            if (idx < 0 || idx > 25) return _m;
            return `<value name="ADD${idx}">`;
        });
    });

    out = replaceInXmlBlockSegments(out, 'text', (seg) => {
        return seg.replace(/<field\s+name="MSG">/gi, '<field name="TEXT">');
    });

    // Blockly core has no built-in "link" toolbox item registry entry.
    // Drop legacy link tags to avoid "[link][toolboxitem]" runtime errors.
    out = out.replace(/<\s*link\b[^>]*>([\s\S]*?)<\/\s*link\s*>/gi, '');
    out = out.replace(/<\s*link\b[^>]*\/>/gi, '');

    return out;
};

const sanitizeLegacyToolboxJson = (input: any): any => {
    if (Array.isArray(input)) {
        return input.map((item) => sanitizeLegacyToolboxJson(item)).filter((item) => item != null);
    }
    if (!input || typeof input !== 'object') return input;

    const node: any = { ...input };
    const kind = String(node.kind || '').trim().toLowerCase();

    if (kind === 'link') {
        const text =
            String(node.text || node.name || node.label || node.url || '').trim() ||
            'link';
        return {
            kind: 'label',
            text,
        };
    }

    if (Array.isArray(node.contents)) {
        node.contents = node.contents
            .map((child: any) => sanitizeLegacyToolboxJson(child))
            .filter((child: any) => child != null);
    }
    if (node.inputs && typeof node.inputs === 'object') {
        const nextInputs: Record<string, any> = {};
        for (const [key, value] of Object.entries(node.inputs)) {
            nextInputs[String(key)] = sanitizeLegacyToolboxJson(value);
        }
        node.inputs = nextInputs;
    }
    if (node.block && typeof node.block === 'object') {
        node.block = sanitizeLegacyToolboxJson(node.block);
    }
    if (node.shadow && typeof node.shadow === 'object') {
        node.shadow = sanitizeLegacyToolboxJson(node.shadow);
    }

    return node;
};

/**
 * 璇诲彇骞惰繑鍥炵粰瀹氭墿灞曠殑 toolbox.json (鑿滃崟鍒嗙被缁撴瀯)
 */
export async function fetchExtensionToolbox(ext: ExtensionInfo, visualColour?: string): Promise<any | null> {
    const configuredToolboxPath = String(ext.toolbox_path || '').replace(/\\/g, '/');
    if (configuredToolboxPath && !isSafeDeclarativeEntrypoint(configuredToolboxPath, 'toolbox')) {
        console.error(
            `[Extensions ${EXT_LOADER_RUNTIME_REV}] Rejected unsupported toolbox entrypoint for ${ext.id}:`,
            configuredToolboxPath,
        );
        return null;
    }

    const configuredIsXml = configuredToolboxPath.toLowerCase().endsWith('.xml');
    const toolboxJsonPath = configuredIsXml
        ? null
        : (configuredToolboxPath || `${ext.dir_path}/toolbox.json`);
    if (toolboxJsonPath) {
        let toolboxJsonStr: string | null = null;
        try {
            toolboxJsonStr = await readTextFileCached(toolboxJsonPath);
        } catch (readError) {
            if (configuredToolboxPath) {
                console.error(`[Extensions ${EXT_LOADER_RUNTIME_REV}] Failed to read toolbox JSON for ${ext.id}:`, readError);
                return null;
            }
        }
        if (toolboxJsonStr !== null) {
            try {
                const parsed = sanitizeLegacyToolboxJson(
                    parseDeclarativeToolboxDocument(toolboxJsonStr),
                );
                const blocklyApi = resolveBlocklyApi();
                ensureRuntimeNewBlockGuard(blocklyApi);
                const ensured = ensureToolboxFallbackBlocksFromJson(parsed, ext.id, blocklyApi);
                if (ensured > 0) {
                    console.warn(`[Extensions] Added ${ensured} toolbox fallback blocks for ${ext.id} (toolbox.json).`);
                }
                return parsed;
            } catch (validationError) {
                console.error(`[Extensions ${EXT_LOADER_RUNTIME_REV}] Rejected toolbox JSON for ${ext.id}:`, validationError);
                return null;
            }
        }
    }

    try {
        const xmlPath = await resolveLegacyToolboxXmlPath(ext);
        if (!xmlPath) return null;
        const xml = validateDeclarativeToolboxXml(await readTextFileCached(xmlPath));
        const normalizedXml = validateDeclarativeToolboxXml(
            normalizeLegacyToolboxXml(
                applyExtensionFallbackColourToToolboxXml(xml, visualColour),
            ),
        );
        const blocklyApi = resolveBlocklyApi();
        ensureRuntimeNewBlockGuard(blocklyApi);
        const ensured = ensureToolboxFallbackBlocksFromXml(normalizedXml, ext.id, blocklyApi);
        if (ensured > 0) {
            console.warn(`[Extensions] Added ${ensured} toolbox fallback blocks for ${ext.id} (toolbox.xml).`);
        }
        return normalizedXml;
    } catch (xmlError) {
        console.error(`[Extensions ${EXT_LOADER_RUNTIME_REV}] Rejected toolbox XML for ${ext.id}:`, xmlError);
        return null;
    }
}

export function registerToolboxBlockVisualColours(toolboxPayload: any, visualColour?: string): void {
    if (!visualColour || !toolboxPayload) return;
    const blocksObj = resolveBlocklyApi()?.Blocks || (Blockly as any)?.Blocks;
    const registerType = (rawType: any) => {
        const type = normalizeLegacyToolboxBlockType(rawType);
        if (!type || isProtectedCoreBlockType(type)) return;
        extensionBlockVisualColours.set(type, visualColour);

        const definition = blocksObj?.[type];
        if (!definition || typeof definition.init !== 'function') return;
        definition.__ckToolboxVisualColour = visualColour;
        if (definition.__ckToolboxVisualColourWrapped) return;

        const originalInit = definition.init;
        definition.init = function (...args: any[]) {
            const result = originalInit.apply(this, args);
            try { (this as any).setColour?.(definition.__ckToolboxVisualColour); } catch { }
            return result;
        };
        definition.__ckToolboxVisualColourWrapped = true;
    };

    if (typeof toolboxPayload === 'string') {
        if (typeof DOMParser !== 'undefined') {
            try {
                const parser = new DOMParser();
                const document = parser.parseFromString(`<xml>${toolboxPayload}</xml>`, 'text/xml');
                if (!document.querySelector('parsererror')) {
                    document.querySelectorAll('block[type]').forEach((block) => {
                        registerType(block.getAttribute('type'));
                    });
                    return;
                }
            } catch { }
        }
        const blockTypePattern = /<block\b[^>]*\btype=(['"])(.*?)\1/gi;
        let match: RegExpExecArray | null;
        while ((match = blockTypePattern.exec(toolboxPayload)) !== null) {
            registerType(match[2]);
        }
        return;
    }

    const walk = (node: any) => {
        if (!node) return;
        if (Array.isArray(node)) {
            node.forEach(walk);
            return;
        }
        if (typeof node !== 'object') return;
        if (String(node.kind || '').toLowerCase() === 'block') registerType(node.type);
        if (node.block && typeof node.block === 'object') registerType(node.block.type);
        if (Array.isArray(node.contents)) node.contents.forEach(walk);
        if (node.inputs && typeof node.inputs === 'object') {
            Object.values(node.inputs).forEach(walk);
        }
    };
    walk(toolboxPayload);
}

const normalizeToolboxFieldValue = (blockType: string, fieldName: string, fieldValue: any): any => {
    if (fieldValue && typeof fieldValue === 'object') {
        return fieldValue;
    }

    const raw = String(fieldValue ?? '');
    const upper = raw.toUpperCase();
    const colorLikeField = /COLOR|COLOUR/.test(String(fieldName || '').toUpperCase());
    const tftPresetColorBlock = String(blockType || '').toLowerCase() === 'tft_preset_color';
    if (colorLikeField || tftPresetColorBlock) {
        if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw;
        const named: Record<string, string> = {
            'CRGB::WHITE': '#ffffff',
            'CRGB::BLACK': '#000000',
            'CRGB::RED': '#ff0000',
            'CRGB::GREEN': '#00ff00',
            'CRGB::BLUE': '#0000ff',
            'CRGB::YELLOW': '#ffff00',
            'CRGB::CYAN': '#00ffff',
            'CRGB::MAGENTA': '#ff00ff'
        };
        if (named[upper]) return named[upper];
    }
    return raw;
};

const escapeXmlText = (value: any): string => {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
};

const toolboxFieldToXml = (indent: string, blockType: string, fieldName: any, fieldValue: any): string => {
    const name = escapeXmlText(fieldName);
    const normalized = normalizeToolboxFieldValue(blockType, String(fieldName || ''), fieldValue);
    const metaByField = compatVariableFieldMetaByBlockType.get(String(blockType || '').trim()) || null;
    const fieldMeta: CompatVariableFieldMeta | undefined =
        metaByField?.[String(fieldName || '').trim().toUpperCase()];
    const resolveVariableType = (explicitType?: any): string => {
        const explicit = String(explicitType ?? '').trim();
        if (explicit) return explicit;
        const metaDefault = String(fieldMeta?.defaultType ?? '').trim();
        if (metaDefault) return metaDefault;
        if (Array.isArray(fieldMeta?.variableTypes)) {
            const firstAllowed = fieldMeta!.variableTypes!.find((item) => String(item ?? '').trim().length > 0);
            if (firstAllowed) return String(firstAllowed).trim();
        }
        return '';
    };

    if (normalized && typeof normalized === 'object' && !Array.isArray(normalized)) {
        const obj: any = normalized;
        const text = obj.name ?? obj.value ?? obj.text ?? '';
        const idAttr = obj.id ? ` id="${escapeXmlText(obj.id)}"` : '';
        const hasExplicitVariableType =
            Object.prototype.hasOwnProperty.call(obj, 'variableType') ||
            Object.prototype.hasOwnProperty.call(obj, 'variabletype');
        const varType = resolveVariableType(
            hasExplicitVariableType
                ? (obj.variableType ?? obj.variabletype ?? '')
                : ''
        );
        const varTypeAttr = varType ? ` variabletype="${escapeXmlText(varType)}"` : '';
        return `${indent}<field name="${name}"${idAttr}${varTypeAttr}>${escapeXmlText(text)}</field>\n`;
    }

    const varType = resolveVariableType();
    const varTypeAttr = varType ? ` variabletype="${escapeXmlText(varType)}"` : '';
    return `${indent}<field name="${name}"${varTypeAttr}>${escapeXmlText(normalized)}</field>\n`;
};

const buildCompatInputEntry = (compatDefault: any, rawFieldValue?: any): any | null => {
    if (!compatDefault || typeof compatDefault !== 'object') return null;
    const shadowType = String(compatDefault.shadowType || '').trim();
    if (!shadowType) return null;
    const shadowField = String(compatDefault.shadowField || 'VALUE');
    const value = (typeof rawFieldValue !== 'undefined') ? rawFieldValue : compatDefault.value;

    if (compatDefault.mode === 'number') {
        const n = Number(value);
        return {
            shadow: {
                type: shadowType,
                fields: {
                    [shadowField]: Number.isFinite(n) ? n : 0
                }
            }
        };
    }

    return {
        shadow: {
            type: shadowType,
            fields: {
                [shadowField]: String(value ?? '')
            }
        }
    };
};

/**
 * 杞婚噺杞崲鍣細灏?JSON 鏍煎紡鐨?Toolbox 杞负 XML 瀛楃涓?
 * 杩欒鎴戜滑鏃犻渶閲嶆瀯椤圭洰鍘熸湰鐨勫法澶?XML 澹版槑锛岀洿鎺ョ儹琛ヤ竵鎷兼帴鍒板熬閮ㄥ嵆鍙?
 */
export function jsonCategoryToXml(categoryJson: any, fallbackColour?: string): string {
    if (typeof categoryJson === 'string') {
        let xml = String(categoryJson || '').trim();
        if (!xml) return '';
        xml = xml.replace(/<script[\s\S]*?<\/script>/gi, '').trim();
        if (!xml) return '';
        xml = xml.replace(/<\?xml[\s\S]*?\?>/gi, '').trim();
        xml = xml.replace(/<\/?xml[^>]*>/gi, '').trim();
        xml = applyExtensionFallbackColourToToolboxXml(xml, fallbackColour);
        xml = normalizeLegacyToolboxXml(xml).trim();
        return xml ? `${xml}\n` : '';
    }

    if (Array.isArray(categoryJson)) {
        return categoryJson.map((item) => jsonCategoryToXml(item, fallbackColour)).join('');
    }

    if (!categoryJson || categoryJson.kind !== 'category') return '';

    const configuredColour = categoryJson.colour ?? categoryJson.color;
    const rawColour = fallbackColour && !hasExplicitVisualColour(configuredColour)
        ? fallbackColour
        : (configuredColour != null ? String(configuredColour) : (fallbackColour || '#64748B'));
    const colour = normalizeLegacyHueColour(rawColour);
    let xml = `<category name="${categoryJson.name || 'Extension'}" colour="${colour}">\n`;

    if (Array.isArray(categoryJson.contents)) {
        for (const item of categoryJson.contents) {
            if (item.kind === 'block') {
                const normalizedItemType = normalizeLegacyToolboxBlockType(item.type);
                if (!normalizedItemType) continue;
                xml += `  <block type="${normalizedItemType}">\n`;
                const compatDefaults = compatInputDefaultsByBlockType.get(normalizedItemType) || {};
                const mergedInputs: Record<string, any> = { ...(item.inputs || {}) };

                if (item.fields && typeof item.fields === 'object') {
                    for (const [fieldName, fieldValue] of Object.entries(item.fields)) {
                        const compat = compatDefaults[String(fieldName || '')];
                        if (!compat || mergedInputs[String(fieldName)]) continue;
                        const entry = buildCompatInputEntry(compat, fieldValue);
                        if (entry) {
                            mergedInputs[String(fieldName)] = entry;
                        }
                    }
                }

                for (const [inputName, compat] of Object.entries(compatDefaults)) {
                    if (mergedInputs[inputName]) continue;
                    const entry = buildCompatInputEntry(compat);
                    if (entry) {
                        mergedInputs[inputName] = entry;
                    }
                }

                // 澶勭悊 inputs (渚嬪 shadow blocks)
                if (Object.keys(mergedInputs).length > 0) {
                    for (const [inputName, inputValue] of Object.entries(mergedInputs)) {
                        xml += `    <value name="${inputName}">\n`;

                        const inputObj = inputValue as any;
                        const shadow = inputObj.shadow;
                        const innerBlock = inputObj.block;

                        if (shadow) {
                            xml += `      <shadow type="${shadow.type}">\n`;
                            if (shadow.fields) {
                                for (const [fieldName, fieldValue] of Object.entries(shadow.fields)) {
                                    xml += toolboxFieldToXml('        ', shadow.type, fieldName, fieldValue);
                                }
                            }
                            xml += `      </shadow>\n`;
                        }

                        if (innerBlock) {
                            const normalizedInnerType = normalizeLegacyToolboxBlockType(innerBlock.type);
                            if (!normalizedInnerType) {
                                xml += `      <block type="${escapeXmlText(String(innerBlock.type || ''))}">\n`;
                            } else {
                                xml += `      <block type="${normalizedInnerType}">\n`;
                            }
                            if (innerBlock.fields) {
                                for (const [fieldName, fieldValue] of Object.entries(innerBlock.fields)) {
                                    xml += toolboxFieldToXml('        ', normalizedInnerType || innerBlock.type, fieldName, fieldValue);
                                }
                            }
                            xml += `      </block>\n`;
                        }

                        xml += `    </value>\n`;
                    }
                }

                // 澶勭悊椤跺眰 fields
                if (item.fields) {
                    for (const [fieldName, fieldValue] of Object.entries(item.fields)) {
                        if (compatDefaults[String(fieldName || '')]) continue;
                        xml += toolboxFieldToXml('    ', normalizedItemType, fieldName, fieldValue);
                    }
                }

                xml += `  </block>\n`;
            }
        }
    }

    xml += `</category>\n`;
    return xml;
}
