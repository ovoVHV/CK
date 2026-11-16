import { exists, mkdir, readDir, readTextFile } from '@tauri-apps/plugin-fs';
import { documentDir, join } from '@tauri-apps/api/path';
import {
    BlockExample,
    BlockManifestEntry,
    BlockManifestKind,
    BlockPackageManifest,
    BlockSearchEntry,
    LibraryInfo,
    LibraryDiagnostic,
    LibraryHardwareValidation,
    LibraryManifest,
    LibraryPackage,
} from '../types/library';
import {
    adaptLegacyPackageLocale,
    createBlockPackageLocaleBundle,
    discoverPackageLocales,
    parseBlockPackageLocaleDocument,
    type BlockPackageLocaleBundle,
} from './block_package_locale';

const CUSTOM_DIR_NAME = 'CK';
const LIBRARIES_DIR_NAME = 'libraries';
const BLOCK_MANIFEST_FILE = 'ck-blocks.json';
const LOCALES_DIR_NAME = 'locales';

const LEGACY_ENTRYPOINTS = {
    blocks: ['blocks.js', 'blocks/blocks.js', 'src/blocks.js'],
    generator: ['generator.js', 'blocks/generator.js', 'generator/generator.js', 'src/generator.js'],
    toolbox: ['toolbox.xml', 'blocks/toolbox.xml'],
} as const;

interface ResolvedExtensions {
    blocks?: string;
    generator?: string;
    toolbox?: string;
    legacy: boolean;
}

const BLOCK_ID_RE = /^[A-Za-z][A-Za-z0-9_]*$/;
const PACKAGE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const BLOCK_KINDS = new Set<BlockManifestKind>(['statement', 'value', 'hat', 'terminal']);
const HARDWARE_VALIDATION_LEVELS = new Set(['compile', 'upload', 'runtime']);
const HARDWARE_VALIDATION_FQBN_RE = /^[A-Za-z0-9._-]+:[A-Za-z0-9._-]+:[A-Za-z0-9._-]+(?::[A-Za-z0-9._=,~-]+)?$/;

function parseHardwareValidation(value: unknown): LibraryHardwareValidation | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const targets = (value as Record<string, unknown>).tested_targets;
    if (!Array.isArray(targets) || targets.length < 1 || targets.length > 64) return undefined;
    const parsed = targets.map((target) => {
        if (!target || typeof target !== 'object' || Array.isArray(target)) return null;
        const raw = target as Record<string, unknown>;
        const fqbn = typeof raw.fqbn === 'string' ? raw.fqbn.trim() : '';
        const testedAt = typeof raw.tested_at === 'string' ? raw.tested_at.trim() : '';
        const levels = Array.isArray(raw.levels)
            ? raw.levels.filter((level): level is 'compile' | 'upload' | 'runtime' => (
                typeof level === 'string' && HARDWARE_VALIDATION_LEVELS.has(level)
            ))
            : [];
        const uniqueLevels = new Set(levels);
        const hasCompile = uniqueLevels.has('compile');
        const hasUpload = uniqueLevels.has('upload');
        const hasRuntime = uniqueLevels.has('runtime');
        if (!HARDWARE_VALIDATION_FQBN_RE.test(fqbn)
            || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z)?$/.test(testedAt)
            || levels.length !== uniqueLevels.size
            || levels.length < 1
            || (hasUpload && !hasCompile)
            || (hasRuntime && !hasUpload)) return null;
        const optionalText = (key: string): string | undefined => (
            typeof raw[key] === 'string' ? raw[key].trim() || undefined : undefined
        );
        return {
            fqbn,
            board_name: optionalText('board_name'),
            core_version: optionalText('core_version'),
            levels,
            tested_at: testedAt,
            ck_version: optionalText('ck_version'),
            example: optionalText('example'),
            notes: optionalText('notes'),
        };
    });
    if (parsed.some(target => !target)) return undefined;
    return { tested_targets: parsed as LibraryHardwareValidation['tested_targets'] };
}

function manifestFromLibraryJson(raw: LibraryPackage): LibraryManifest {
    const value = raw as unknown as Record<string, unknown>;
    const optionalText = (key: string): string | undefined => (
        typeof value[key] === 'string' ? value[key].trim() || undefined : undefined
    );
    return {
        name: raw.name,
        version: raw.version,
        author: optionalText('author'),
        maintainer: optionalText('maintainer'),
        sentence: optionalText('sentence'),
        paragraph: optionalText('paragraph'),
        website: optionalText('website'),
        category: optionalText('category'),
        architectures: stringList(value.architectures),
        includes: stringList(value.includes),
        id: raw.id,
        hardware_validation: parseHardwareValidation(value.hardware_validation),
    };
}

async function loadPackageLocaleBundle(
    libDir: string,
    manifest: BlockPackageManifest | null,
    diagnostics: LibraryDiagnostic[],
): Promise<BlockPackageLocaleBundle> {
    const legacyFallback = adaptLegacyPackageLocale(manifest || {});
    const localesDir = await join(libDir, LOCALES_DIR_NAME);
    if (!(await exists(localesDir))) return legacyFallback;

    let files: string[] = [];
    try {
        const entries = await readDir(localesDir);
        files = entries
            .filter((entry: any) => !entry?.isDirectory)
            .map((entry: any) => String(entry?.name || ''));
    } catch {
        return legacyFallback;
    }

    const localeFiles = discoverPackageLocales(files);
    const actualFileByLocale = new Map(
        files.map((fileName) => [fileName.replace(/\\/g, '/').toLowerCase(), fileName]),
    );
    const documents = [];
    for (const locale of localeFiles) {
        try {
            const actualFileName = actualFileByLocale.get(`${locale}.json`.toLowerCase()) || `${locale}.json`;
            const localePath = await join(localesDir, actualFileName);
            documents.push(parseBlockPackageLocaleDocument(
                await readTextFile(localePath),
                locale,
            ));
        } catch (error) {
            diagnostics.push({
                code: 'invalid-locale',
                severity: 'warning',
                message: `积木包语言文件 ${locale}.json 无效，已回退到可用展示文本。`,
            });
        }
    }
    if (documents.length === 0) return legacyFallback;

    try {
        return createBlockPackageLocaleBundle(documents, manifest?.defaultLocale, false);
    } catch (error) {
        diagnostics.push({
            code: 'invalid-locale',
            severity: 'warning',
            message: '积木包 defaultLocale 未找到对应语言文件，已使用可用语言展示。',
        });
        // A malformed locale declaration must not prevent package loading. The
        // machine package remains intact and presentation falls back safely.
        return createBlockPackageLocaleBundle(documents, undefined, false);
    }
}

/**
 * Hydrate backend library records with presentation-only package locales.
 *
 * The Rust registry intentionally remains the source of machine package
 * identity.  Locale files are optional UI data, so they are loaded in the
 * WebView from each already-approved package path and attached to a detached
 * copy of the record.  A malformed locale can therefore never block the
 * package itself from loading or alter its runtime identity.
 */
export async function hydrateBlockPackageLocales(
    libraries: readonly LibraryInfo[],
): Promise<LibraryInfo[]> {
    return Promise.all(libraries.map(async (library) => {
        if (!library?.path || library.block_locale_bundle === undefined) {
            if (!library?.path) return library;
        }

        const diagnostics = [...(library.diagnostics || [])];
        try {
            const bundle = library.block_locale_bundle !== undefined
                ? library.block_locale_bundle
                : await loadPackageLocaleBundle(
                    library.path,
                    library.block_manifest || null,
                    diagnostics,
                );
            return {
                ...library,
                block_locale_bundle: bundle,
                diagnostics,
            };
        } catch (error) {
            console.warn(`[LibraryManager] Failed to hydrate locale for ${library.id}`, error);
            return { ...library, diagnostics };
        }
    }));
}

function stringList(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return [...new Set(value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean))];
}

function isSafeRelativeEntrypoint(value: unknown): value is string {
    if (typeof value !== 'string') return false;
    const normalized = value.trim().replace(/\\/g, '/');
    if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return false;
    return normalized.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

function parseBlockEntry(value: unknown): BlockManifestEntry | null {
    if (!value || typeof value !== 'object') return null;
    const raw = value as Record<string, unknown>;
    const type = typeof raw.type === 'string' ? raw.type.trim() : '';
    const displayName = typeof raw.display_name === 'string' ? raw.display_name.trim() : '';
    const description = typeof raw.description === 'string' ? raw.description.trim() : '';
    if (!BLOCK_ID_RE.test(type) || !displayName || !description) return null;

    const kind = typeof raw.kind === 'string' && BLOCK_KINDS.has(raw.kind as BlockManifestKind)
        ? raw.kind as BlockManifestKind
        : undefined;
    return {
        type,
        display_name: displayName,
        description,
        category: typeof raw.category === 'string' ? raw.category.trim() || undefined : undefined,
        kind,
        keywords: stringList(raw.keywords),
        fields: Array.isArray(raw.fields) ? raw.fields as BlockManifestEntry['fields'] : [],
        inputs: Array.isArray(raw.inputs) ? raw.inputs as BlockManifestEntry['inputs'] : [],
        output: typeof raw.output === 'string' || Array.isArray(raw.output) || raw.output === null || (raw.output && typeof raw.output === 'object')
            ? raw.output as BlockManifestEntry['output']
            : undefined,
        requires: stringList(raw.requires),
        semantics: raw.semantics && typeof raw.semantics === 'object' && !Array.isArray(raw.semantics)
            ? raw.semantics as BlockManifestEntry['semantics']
            : undefined,
        dependencies: Array.isArray(raw.dependencies)
            ? raw.dependencies as BlockManifestEntry['dependencies']
            : undefined,
        hardware: raw.hardware && typeof raw.hardware === 'object' && !Array.isArray(raw.hardware)
            ? raw.hardware as BlockManifestEntry['hardware']
            : undefined,
        generation: raw.generation && typeof raw.generation === 'object' && !Array.isArray(raw.generation)
            ? raw.generation as BlockManifestEntry['generation']
            : undefined,
        constraints: Array.isArray(raw.constraints)
            ? raw.constraints as BlockManifestEntry['constraints']
            : undefined,
        errors: Array.isArray(raw.errors)
            ? raw.errors as BlockManifestEntry['errors']
            : undefined,
        examples: Array.isArray(raw.examples) ? raw.examples.filter(example => typeof example === 'string' || (example && typeof example === 'object' && !Array.isArray(example))) as BlockManifestEntry['examples'] : undefined,
    };
}

function parseManifest(value: string, directoryId: string): BlockPackageManifest | null {
    try {
        const parsed = JSON.parse(value) as Partial<BlockPackageManifest>;
        const id = typeof parsed.id === 'string' ? parsed.id.trim() : '';
        if (![1, 2].includes(Number(parsed.schema_version)) || !PACKAGE_ID_RE.test(id)) {
            return null;
        }
        const entrypoints = parsed.entrypoints;
        if (entrypoints && [entrypoints.blocks, entrypoints.generator, entrypoints.toolbox]
            .some((entrypoint) => entrypoint !== undefined && !isSafeRelativeEntrypoint(entrypoint))) {
            return null;
        }
        const blocks = Array.isArray(parsed.blocks)
            ? parsed.blocks.map(parseBlockEntry).filter((entry): entry is BlockManifestEntry => Boolean(entry))
            : [];
        if (Array.isArray(parsed.blocks) && blocks.length !== parsed.blocks.length) return null;
        const uniqueTypes = new Set(blocks.map((block) => block.type));
        if (uniqueTypes.size !== blocks.length) return null;
        return {
            schema_version: parsed.schema_version === 2 ? 2 : 1,
            id: id || directoryId,
            defaultLocale: typeof (parsed as any).defaultLocale === 'string'
                ? (parsed as any).defaultLocale.trim() || undefined
                : undefined,
            display_name: parsed.display_name,
            description: parsed.description,
            keywords: stringList(parsed.keywords),
            compatibility: parsed.compatibility,
            entrypoints,
            blocks,
        };
    } catch {
        return null;
    }
}

async function firstExisting(libDir: string, candidates: readonly string[]): Promise<string | undefined> {
    for (const candidate of candidates) {
        const path = await join(libDir, ...candidate.split('/'));
        if (await exists(path)) return path;
    }
    return undefined;
}

async function resolveExtensions(libDir: string, manifest: BlockPackageManifest | null): Promise<ResolvedExtensions> {
    const entrypoints = manifest?.entrypoints;
    const standard = entrypoints ? {
        blocks: entrypoints.blocks ? [entrypoints.blocks] : [],
        generator: entrypoints.generator ? [entrypoints.generator] : [],
        toolbox: entrypoints.toolbox ? [entrypoints.toolbox] : [],
    } : null;

    const blocks = await firstExisting(libDir, standard?.blocks.length ? standard.blocks : LEGACY_ENTRYPOINTS.blocks);
    const generator = await firstExisting(libDir, standard?.generator.length ? standard.generator : LEGACY_ENTRYPOINTS.generator);
    const toolbox = await firstExisting(libDir, standard?.toolbox.length ? standard.toolbox : LEGACY_ENTRYPOINTS.toolbox);

    return { blocks, generator, toolbox, legacy: !manifest };
}

function toolboxEntries(toolbox: string, manifest: BlockPackageManifest | null): BlockSearchEntry[] {
    if (!toolbox.trim() || typeof DOMParser === 'undefined') return [];
    const parser = new DOMParser();
    let document = parser.parseFromString(toolbox, 'text/xml');
    if (document.querySelector('parsererror') || document.documentElement.tagName.toLowerCase() !== 'xml') {
        document = parser.parseFromString(`<xml>${toolbox}</xml>`, 'text/xml');
    }
    if (document.querySelector('parsererror')) return [];

    const manifestByType = new Map((manifest?.blocks || []).map((block) => [block.type, block]));
    const packageKeywords = [...new Set([
        ...(manifest?.keywords || []),
        manifest?.display_name || '',
        manifest?.description || '',
    ].join(' ').toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(Boolean))];
    const entries: BlockSearchEntry[] = [];
    const seen = new Set<string>();
    const serializer = new XMLSerializer();

    const visitCategory = (categoryNode: Element, parents: string[]) => {
        const ownName = categoryNode.getAttribute('name')?.trim() || '';
        const categoryPath = ownName ? [...parents, ownName] : parents;
        for (const child of Array.from(categoryNode.children)) {
            const tag = child.tagName.toLowerCase();
            if (tag === 'category') {
                visitCategory(child, categoryPath);
                continue;
            }
            if (tag !== 'block') continue;
            const type = child.getAttribute('type')?.trim() || '';
            if (!type || seen.has(type)) continue;
            seen.add(type);
            const metadata = manifestByType.get(type);
            entries.push({
                type,
                category: metadata?.category || categoryPath.join(' / ') || undefined,
                display_name: metadata?.display_name,
                description: metadata?.description,
                kind: metadata?.kind,
                keywords: [...new Set([
                    ...packageKeywords,
                    ...(metadata?.keywords || []),
                    ...type.toLowerCase().split(/[_-]+/).filter(Boolean),
                ])],
                fields: metadata?.fields,
                inputs: metadata?.inputs,
                output: metadata?.output,
                requires: metadata?.requires,
                semantics: metadata?.semantics,
                dependencies: metadata?.dependencies,
                hardware: metadata?.hardware,
                generation: metadata?.generation,
                constraints: metadata?.constraints,
                examples: metadata?.examples?.filter((example): example is BlockExample => typeof example === 'object' && example !== null),
                output_contract: metadata?.output && typeof metadata.output === 'object' && !Array.isArray(metadata.output) ? metadata.output : undefined,
                errors: metadata?.errors,
                xml_template: serializer.serializeToString(child),
                library_id: manifest?.id,
                source: metadata ? 'manifest' : 'toolbox',
            });
        }
    };

    for (const child of Array.from(document.documentElement.children)) {
        if (child.tagName.toLowerCase() === 'category') visitCategory(child, []);
    }
    return entries;
}

/**
 * Standard custom Blockly package layout:
 *   library.json, ck-blocks.json, blocks/blocks.js, blocks/generator.js,
 *   blocks/toolbox.xml, assets/
 * Legacy packages remain supported through the historical lookup paths.
 */
export class LibraryManager {
    static async getLibrariesRootPath(board: string): Promise<string> {
        const docs = await documentDir();
        return join(docs, CUSTOM_DIR_NAME, LIBRARIES_DIR_NAME, board.replace(/:/g, '_'));
    }

    static async init(board: string): Promise<void> {
        const path = await this.getLibrariesRootPath(board);
        if (!(await exists(path))) await mkdir(path, { recursive: true });
    }

    static async loadUserLibraries(board: string): Promise<LibraryPackage[]> {
        const packages: LibraryPackage[] = [];
        const knownBlockTypes = new Map<string, string>();
        const rootPath = await this.getLibrariesRootPath(board);
        if (!(await exists(rootPath))) return packages;

        for (const entry of await readDir(rootPath)) {
            if (!entry.isDirectory) continue;
            try {
                const libDir = await join(rootPath, entry.name);
                const libraryPath = await join(libDir, 'library.json');
                if (!(await exists(libraryPath))) continue;

                const pkg = JSON.parse(await readTextFile(libraryPath)) as LibraryPackage;
                const diagnostics: LibraryDiagnostic[] = [];
                const rawHardwareValidation = (pkg as unknown as Record<string, unknown>).hardware_validation;
                pkg.manifest = manifestFromLibraryJson(pkg);
                if (rawHardwareValidation !== undefined && !pkg.manifest.hardware_validation) {
                    diagnostics.push({
                        code: 'invalid-hardware-validation',
                        severity: 'warning',
                        message: 'library.json 的 hardware_validation 无效，已忽略作者真机验证声明。',
                    });
                }
                const blockManifestPath = await join(libDir, BLOCK_MANIFEST_FILE);
                const blockManifest = (await exists(blockManifestPath))
                    ? parseManifest(await readTextFile(blockManifestPath), entry.name)
                    : null;
                if ((await exists(blockManifestPath)) && !blockManifest) {
                    diagnostics.push({ code: 'invalid-manifest', severity: 'error', message: `${BLOCK_MANIFEST_FILE} 的版本、ID、入口路径或积木目录无效。` });
                }
                if (blockManifest && blockManifest.id !== entry.name) {
                    diagnostics.push({ code: 'id-mismatch', severity: 'warning', message: `积木包 ID (${blockManifest.id}) 与目录名 (${entry.name}) 不一致。` });
                }
                if (blockManifest && (!blockManifest.blocks || blockManifest.blocks.length === 0)) {
                    diagnostics.push({ code: 'missing-block-catalog', severity: 'warning', message: `${BLOCK_MANIFEST_FILE} 尚未声明 blocks，AI 只能从工具箱推断积木。` });
                }

                const resolved = await resolveExtensions(libDir, blockManifest);
                if (resolved.legacy && (resolved.blocks || resolved.generator || resolved.toolbox)) {
                    diagnostics.push({ code: 'legacy-layout', severity: 'info', message: '使用兼容旧积木目录；建议迁移到 ck-blocks.json 与 blocks/ 目录。' });
                }
                if (!resolved.blocks) diagnostics.push({ code: 'missing-blocks', severity: 'warning', message: '未找到积木定义文件。' });
                if (!resolved.generator) diagnostics.push({ code: 'missing-generator', severity: 'warning', message: '未找到 Arduino 代码生成器文件。' });
                if (!resolved.toolbox) diagnostics.push({ code: 'missing-toolbox', severity: 'warning', message: '未找到 Blockly 工具箱分类文件。' });

                const toolbox = resolved.toolbox ? await readTextFile(resolved.toolbox) : '';
                const blockSearchEntries = toolboxEntries(toolbox, blockManifest);
                for (const block of blockSearchEntries) {
                    const owner = knownBlockTypes.get(block.type);
                    if (owner) diagnostics.push({ code: 'duplicate-block-type', severity: 'error', message: `积木类型 ${block.type} 与 ${owner} 重复。` });
                    else knownBlockTypes.set(block.type, pkg.name || entry.name);
                }

                pkg.id = entry.name;
                pkg.dir_path = libDir;
                pkg.assets_path = await join(libDir, 'assets');
                pkg.block_manifest = blockManifest || undefined;
                pkg.block_locale_bundle = await loadPackageLocaleBundle(libDir, blockManifest, diagnostics);
                pkg.block_search_entries = blockSearchEntries;
                pkg.diagnostics = diagnostics;
                pkg.extensions = {
                    blocks_code: resolved.blocks ? await readTextFile(resolved.blocks) : undefined,
                    generator_code: resolved.generator ? await readTextFile(resolved.generator) : undefined,
                    toolbox_category: toolbox || undefined,
                };

                for (const candidate of ['icon.png', 'icon.jpg', 'icon.svg', 'icon.webp', 'library.png']) {
                    const iconPath = await join(libDir, candidate);
                    if (await exists(iconPath)) {
                        pkg.icon = iconPath;
                        break;
                    }
                }
                packages.push(pkg);
            } catch (error) {
                console.warn(`[LibraryManager] Failed to load ${entry.name}`, error);
            }
        }
        return packages;
    }
}
