import type {
    BlockDependency,
    BlockExample,
    BlockManifestEntry,
    BlockMetadataSection,
    BlockOutputContract,
    BlockPackageLicense,
    BlockSearchEntry,
    LibraryInfo,
} from '../types/library';
import { resolveBlockPackagePresentation, type BlockPackageLocaleBundle } from './block_package_locale';

export interface BlockCatalogSnapshot {
    schemaVersion: 2;
    board: string;
    generatedAt: string;
    blockCount: number;
    blocks: BlockSearchEntry[];
}

interface ManifestOwner {
    libraryId: string;
    manifest: NonNullable<LibraryInfo['block_manifest']>;
    localeBundle?: BlockPackageLocaleBundle;
    packageKeywords: string[];
    packageDependencies: BlockDependency[];
    packageLicense?: BlockPackageLicense;
    schemaVersion: 1 | 2;
    block: BlockManifestEntry;
}

const METADATA_SECTIONS: BlockMetadataSection[] = [
    'semantics',
    'dependencies',
    'output',
    'hardware',
    'generation',
    'constraints',
    'examples',
    'errors',
];

function hasOwn(value: object, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(value, key);
}

function normalizeOutput(output: BlockManifestEntry['output']): BlockOutputContract | undefined {
    if (output === undefined) return undefined;
    if (output === null) return { connection: 'none', types: [] };
    if (typeof output === 'object' && !Array.isArray(output)) {
        return {
            ...output,
            types: Array.isArray(output.types) ? [...new Set(output.types)] : [],
        };
    }
    return {
        connection: 'value',
        types: [...new Set(Array.isArray(output) ? output : [output])],
        nullable: false,
    };
}

function normalizeExamples(examples: BlockManifestEntry['examples']): BlockExample[] {
    if (!Array.isArray(examples)) return [];
    return examples.flatMap((example, index) => {
        if (typeof example === 'string') {
            const description = example.trim();
            if (!description) return [];
            return [{
                id: `legacy-example-${index + 1}`,
                title: description,
                description,
                expected_behavior: description,
            }];
        }
        return example?.id && example.title && example.description && example.expected_behavior
            ? [{ ...example }]
            : [];
    });
}

function dependencyKey(dependency: BlockDependency): string {
    return [dependency.kind, dependency.id, dependency.version || '', ...(dependency.headers || [])].join('\u0000');
}

function normalizeDependencies(
    block: BlockManifestEntry,
    packageDependencies: BlockDependency[],
): BlockDependency[] {
    const legacyRequirements: BlockDependency[] = (block.requires || []).map((requirement) => {
        const isHeader = /\.(?:h|hpp)$/i.test(requirement);
        return {
            kind: isHeader ? 'header' : 'capability',
            id: requirement,
            ...(isHeader ? { headers: [requirement] } : {}),
            reason: '由 v1 requires 字段迁移；未计入 v2 完整性证明',
        };
    });
    const dependencies = [...packageDependencies, ...(block.dependencies || []), ...legacyRequirements];
    const seen = new Set<string>();
    return dependencies.filter((dependency) => {
        const key = dependencyKey(dependency);
        if (!dependency.id || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

/**
 * Turns both legacy v1 declarations and v2 declarations into one predictable
 * search/AI contract. Adapted values never count as publisher-declared metadata;
 * consumers can use metadata_completeness to avoid treating a fallback as proof.
 */
export function normalizeBlockManifestEntry(
    block: BlockManifestEntry,
    schemaVersion: 1 | 2,
    packageDependencies: BlockDependency[] = [],
): Pick<BlockSearchEntry,
    | 'metadata_schema_version'
    | 'metadata_source'
    | 'metadata_completeness'
    | 'semantics'
    | 'dependencies'
    | 'output_contract'
    | 'hardware'
    | 'generation'
    | 'constraints'
    | 'examples'
    | 'errors'
> {
    const metadataCompleteness = METADATA_SECTIONS.filter((section) => {
        if (section === 'output') return hasOwn(block, 'output') && block.output !== undefined;
        return hasOwn(block, section) && block[section] !== undefined;
    });
    const semantics = block.semantics || {
        purpose: block.description,
        behavior: block.description,
        side_effects: [],
        concepts: block.keywords || [],
    };

    return {
        metadata_schema_version: schemaVersion,
        metadata_source: schemaVersion === 2 ? 'v2' : 'v1-adapted',
        metadata_completeness: metadataCompleteness,
        semantics,
        dependencies: normalizeDependencies(block, packageDependencies),
        output_contract: normalizeOutput(block.output),
        hardware: block.hardware,
        generation: block.generation,
        constraints: block.constraints ? [...block.constraints] : [],
        examples: normalizeExamples(block.examples),
        errors: block.errors ? [...block.errors] : [],
    };
}

function parseToolboxDocument(toolboxXml: string): Document | null {
    if (typeof DOMParser === 'undefined' || !toolboxXml.trim()) return null;
    const parser = new DOMParser();
    const direct = parser.parseFromString(toolboxXml, 'text/xml');
    if (!direct.querySelector('parsererror') && direct.documentElement.tagName.toLowerCase() === 'xml') {
        return direct;
    }
    const wrapped = parser.parseFromString(`<xml>${toolboxXml}</xml>`, 'text/xml');
    return wrapped.querySelector('parsererror') ? null : wrapped;
}

export function isLibraryEligibleForBlockCatalog(library: LibraryInfo): boolean {
    const qualityFailed = library.quality_report?.status === 'failed';
    const hasBlockingDiagnostic = (library.diagnostics || [])
        .some(diagnostic => diagnostic.severity === 'error');
    return !qualityFailed && !hasBlockingDiagnostic;
}

function manifestOwners(libraries: LibraryInfo[]): Map<string, ManifestOwner> {
    const owners = new Map<string, ManifestOwner>();
    for (const library of libraries) {
        if (!isLibraryEligibleForBlockCatalog(library)) continue;
        const manifest = library.block_manifest;
        if (!manifest) continue;
        const packageKeywords = Array.isArray(manifest.keywords) ? manifest.keywords : [];
        const packageDependencies = Array.isArray(manifest.dependencies) ? manifest.dependencies : [];
        for (const block of manifest.blocks || []) {
            if (!block?.type || owners.has(block.type)) continue;
            owners.set(block.type, {
                libraryId: manifest.id || library.id,
                manifest,
                localeBundle: library.block_locale_bundle,
                packageKeywords,
                packageDependencies,
                packageLicense: manifest.license,
                schemaVersion: manifest.schema_version,
                block,
            });
        }
    }
    return owners;
}

export function buildBlockCatalog(
    board: string,
    toolboxXml: string,
    libraries: LibraryInfo[],
    resolveDisplayName?: (blockType: string) => string | undefined,
    blockLocale?: string,
): BlockCatalogSnapshot {
    const document = parseToolboxDocument(toolboxXml);
    const owners = manifestOwners(libraries);
    const blocks: BlockSearchEntry[] = [];
    const seen = new Set<string>();
    const serializer = typeof XMLSerializer === 'undefined' ? null : new XMLSerializer();

    const visitCategory = (
        category: Element,
        parents: string[],
        inheritedCategoryId?: string,
    ) => {
        const name = category.getAttribute('name')?.trim() || '';
        const declaredCategoryId = category.getAttribute('data-category-id')?.trim() || '';
        const categoryId = declaredCategoryId || inheritedCategoryId;
        const categoryPath = name ? [...parents, name] : parents;
        for (const child of Array.from(category.children)) {
            const tag = child.tagName.toLowerCase();
            if (tag === 'category') {
                visitCategory(child, categoryPath, categoryId);
                continue;
            }
            if (tag !== 'block') continue;
            const type = child.getAttribute('type')?.trim() || '';
            if (!type || seen.has(type)) continue;
            seen.add(type);

            const owner = owners.get(type);
            const block = owner?.block;
            const packagePresentation = owner
                ? resolveBlockPackagePresentation(owner.manifest, owner.localeBundle, blockLocale)
                : null;
            const localizedBlock = packagePresentation?.blocks[type];
            const normalized = block
                ? normalizeBlockManifestEntry(block, owner.schemaVersion, owner.packageDependencies)
                : undefined;
            const runtimeDisplayName = localizedBlock?.displayName
                || block?.display_name
                || resolveDisplayName?.(type);
            const runtimeDescription = localizedBlock?.description || block?.description;
            const runtimeCategory = localizedBlock?.category
                || block?.category
                || categoryPath.join(' / ')
                || undefined;
            const keywords = [
                ...(owner?.packageKeywords || []),
                ...(block?.keywords || []),
                ...(localizedBlock ? [localizedBlock.displayName, localizedBlock.description, localizedBlock.tooltip] : []),
                ...type.toLowerCase().split(/[_-]+/).filter(Boolean),
            ].map((keyword) => String(keyword).trim().toLowerCase()).filter(Boolean);

            blocks.push({
                type,
                category_id: categoryId,
                category: runtimeCategory,
                display_name: runtimeDisplayName,
                description: runtimeDescription,
                kind: block?.kind,
                keywords: [...new Set(keywords)],
                fields: block?.fields,
                inputs: block?.inputs,
                output: block?.output,
                requires: block?.requires,
                ...normalized,
                package_license: owner?.packageLicense,
                xml_template: serializer?.serializeToString(child),
                library_id: owner?.libraryId,
                source: block ? 'manifest' : 'toolbox',
            });
        }
    };

    if (document) {
        for (const child of Array.from(document.documentElement.children)) {
            if (child.tagName.toLowerCase() === 'category') visitCategory(child, []);
        }
    }

    return {
        schemaVersion: 2,
        board,
        generatedAt: new Date().toISOString(),
        blockCount: blocks.length,
        blocks,
    };
}
