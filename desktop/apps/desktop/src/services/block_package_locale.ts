import type {
    BlockManifestEntry,
    BlockManifestField,
    BlockPackageManifest,
} from '../types/library';

/**
 * Presentation-only locale data for a block package.
 *
 * The locale document deliberately has no machine definition fields.  A
 * package type, field name, input name, option value, generator and hardware
 * contract can therefore never be replaced by a translated value here.
 */
export interface BlockPackageLocaleDocument {
    $schema?: string;
    locale: string;
    package?: {
        displayName?: string;
        description?: string;
        keywords?: string[];
    };
    categories?: Record<string, string>;
    blocks?: Record<string, BlockPackageBlockLocale>;
}

export interface BlockPackageBlockLocale {
    displayName?: string;
    message?: string;
    tooltip?: string;
    description?: string;
    category?: string;
    fields?: Record<string, BlockPackageFieldLocale>;
}

export interface BlockPackageFieldLocale {
    label?: string;
    options?: Record<string, string>;
}

export interface BlockPackageLocaleBundle {
    defaultLocale: string | null;
    locales: Readonly<Record<string, BlockPackageLocaleDocument>>;
    /** True when the package has no locale directory and uses raw legacy text. */
    legacy: boolean;
}

export type PackageLocaleResolutionSource = 'requested' | 'default' | 'raw';

export interface ResolvedBlockPackageField {
    name: string;
    label: string;
    options: Array<{ label: string; value: string }>;
}

export interface ResolvedBlockPackageBlock {
    type: string;
    displayName: string;
    message: string;
    description: string;
    tooltip: string;
    category?: string;
    fields: ResolvedBlockPackageField[];
}

export interface ResolvedBlockPackagePresentation {
    locale: string | null;
    source: PackageLocaleResolutionSource;
    package: {
        displayName: string;
        description: string;
        keywords: string[];
    };
    categories: Readonly<Record<string, string>>;
    blocks: Readonly<Record<string, ResolvedBlockPackageBlock>>;
}

const LOCALE_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const MACHINE_ID_RE = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;
const MAX_DOCUMENT_BYTES = 512 * 1024;
const MAX_STRING_BYTES = 16 * 1024;
const MAX_KEYS = 10_000;
const MAX_ARRAY_ITEMS = 2048;
const PROTOTYPE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

const encoder = new TextEncoder();
const utf8Bytes = (value: string): number => encoder.encode(value).length;

const isRecord = (value: unknown): value is Record<string, unknown> => (
    value !== null && typeof value === 'object' && !Array.isArray(value)
);

const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

const boundedText = (value: unknown, location: string, required = false): string => {
    if (typeof value !== 'string') {
        if (required) throw new Error(`${location} must be a string`);
        return '';
    }
    if (value.includes('\0')) throw new Error(`${location} contains a NUL byte`);
    if (utf8Bytes(value) > MAX_STRING_BYTES) throw new Error(`${location} is too long`);
    const normalized = value.trim();
    if (required && !normalized) throw new Error(`${location} must not be empty`);
    return normalized;
};

const normalizeLocale = (value: unknown): string => {
    const candidate = text(value);
    if (!LOCALE_RE.test(candidate)) return '';
    const parts = candidate.split('-');
    return parts.map((part, index) => {
        if (index === 0) return part.toLowerCase();
        if (/^[A-Za-z]{2}$/.test(part) || /^\d{3}$/.test(part)) return part.toUpperCase();
        if (/^[A-Za-z]{4}$/.test(part)) return `${part[0].toUpperCase()}${part.slice(1).toLowerCase()}`;
        return part;
    }).join('-');
};

const normalizedLocaleKey = (value: string): string => value.toLowerCase();

const assertSafeKey = (value: string, location: string): void => {
    if (!MACHINE_ID_RE.test(value) || PROTOTYPE_KEYS.has(value.toLowerCase())) {
        throw new Error(`${location} has an invalid key`);
    }
};

/**
 * Category keys are presentation lookup keys for packages that predate an
 * explicit category id.  Keep accepting those legacy (possibly non-ASCII)
 * names, but keep them bounded and inert: they are never written to project
 * data, used as Blockly identities, or evaluated as code.  New packages may
 * still use stable ASCII category ids and take the stricter path above.
 */
const assertSafeCategoryKey = (value: string, location: string): void => {
    if (!value || value.length > 128 || /[\0\r\n]/.test(value) || PROTOTYPE_KEYS.has(value.toLowerCase())) {
        throw new Error(`${location} has an invalid key`);
    }
};

const assertSafeOptionValue = (value: string, location: string): void => {
    if (!value || value.length > 128 || /[\0\r\n]/.test(value) || PROTOTYPE_KEYS.has(value.toLowerCase())) {
        throw new Error(`${location} has an invalid option value`);
    }
};

const boundedStringList = (value: unknown, location: string): string[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > MAX_ARRAY_ITEMS) {
        throw new Error(`${location} must be a bounded string array`);
    }
    return [...new Set(value.map((item, index) => boundedText(item, `${location}[${index}]`)).filter(Boolean))];
};

const countKeys = (value: unknown): number => {
    let count = 0;
    const walk = (candidate: unknown): void => {
        if (!isRecord(candidate)) {
            if (Array.isArray(candidate)) candidate.forEach(walk);
            return;
        }
        for (const child of Object.values(candidate)) {
            count += 1;
            if (count > MAX_KEYS) throw new Error('locale document contains too many keys');
            walk(child);
        }
    };
    walk(value);
    return count;
};

const parseFieldLocale = (value: unknown, location: string): BlockPackageFieldLocale => {
    if (!isRecord(value)) throw new Error(`${location} must be an object`);
    const allowed = new Set(['label', 'options']);
    const unknown = Object.keys(value).filter(key => !allowed.has(key));
    if (unknown.length > 0) throw new Error(`${location} contains unsupported fields`);
    const options: Record<string, string> = {};
    if (value.options !== undefined) {
        if (!isRecord(value.options)) throw new Error(`${location}.options must be an object`);
        for (const [optionValue, optionLabel] of Object.entries(value.options)) {
            assertSafeOptionValue(optionValue, `${location}.options`);
            options[optionValue] = boundedText(optionLabel, `${location}.options.${optionValue}`, true);
        }
    }
    return {
        ...(value.label !== undefined ? { label: boundedText(value.label, `${location}.label`, true) } : {}),
        ...(Object.keys(options).length > 0 ? { options } : {}),
    };
};

const parseBlockLocale = (value: unknown, location: string): BlockPackageBlockLocale => {
    if (!isRecord(value)) throw new Error(`${location} must be an object`);
    const allowed = new Set(['displayName', 'message', 'tooltip', 'description', 'category', 'fields']);
    const unknown = Object.keys(value).filter(key => !allowed.has(key));
    if (unknown.length > 0) throw new Error(`${location} contains unsupported fields`);
    const fields: Record<string, BlockPackageFieldLocale> = {};
    if (value.fields !== undefined) {
        if (!isRecord(value.fields)) throw new Error(`${location}.fields must be an object`);
        for (const [fieldName, fieldValue] of Object.entries(value.fields)) {
            assertSafeKey(fieldName, `${location}.fields`);
            fields[fieldName] = parseFieldLocale(fieldValue, `${location}.fields.${fieldName}`);
        }
    }
    const result: BlockPackageBlockLocale = {
        ...(value.displayName !== undefined ? { displayName: boundedText(value.displayName, `${location}.displayName`, true) } : {}),
        ...(value.message !== undefined ? { message: boundedText(value.message, `${location}.message`, true) } : {}),
        ...(value.tooltip !== undefined ? { tooltip: boundedText(value.tooltip, `${location}.tooltip`, true) } : {}),
        ...(value.description !== undefined ? { description: boundedText(value.description, `${location}.description`, true) } : {}),
        ...(value.category !== undefined ? { category: boundedText(value.category, `${location}.category`, true) } : {}),
        ...(Object.keys(fields).length > 0 ? { fields } : {}),
    };
    if (Object.keys(result).length === 0) throw new Error(`${location} must contain presentation text`);
    return result;
};

/** Parse and validate one declarative package locale JSON document. */
export function parseBlockPackageLocaleDocument(
    source: string,
    expectedLocale?: string,
): BlockPackageLocaleDocument {
    const rawText = String(source ?? '').replace(/^\uFEFF/, '');
    if (utf8Bytes(rawText) > MAX_DOCUMENT_BYTES) throw new Error('package locale exceeds the 512 KiB limit');
    let parsed: unknown;
    try {
        parsed = JSON.parse(rawText);
    } catch (error) {
        throw new Error(`package locale must be strict JSON: ${String(error)}`);
    }
    countKeys(parsed);
    if (!isRecord(parsed)) throw new Error('package locale root must be an object');
    const locale = normalizeLocale(parsed.locale || expectedLocale);
    if (!locale) throw new Error('package locale must declare a valid locale');
    if (expectedLocale && normalizedLocaleKey(locale) !== normalizedLocaleKey(expectedLocale)) {
        throw new Error(`package locale does not match ${expectedLocale}`);
    }
    const allowedRoot = new Set(['$schema', 'locale', 'package', 'categories', 'blocks']);
    const unknownRoot = Object.keys(parsed).filter(key => !allowedRoot.has(key));
    if (unknownRoot.length > 0) throw new Error(`package locale contains unsupported fields: ${unknownRoot.join(', ')}`);

    let packageData: BlockPackageLocaleDocument['package'];
    if (parsed.package !== undefined) {
        if (!isRecord(parsed.package)) throw new Error('package locale package must be an object');
        const unknown = Object.keys(parsed.package).filter(key => !new Set(['displayName', 'description', 'keywords']).has(key));
        if (unknown.length > 0) throw new Error('package locale package contains unsupported fields');
        packageData = {
            ...(parsed.package.displayName !== undefined ? { displayName: boundedText(parsed.package.displayName, 'package.displayName', true) } : {}),
            ...(parsed.package.description !== undefined ? { description: boundedText(parsed.package.description, 'package.description', true) } : {}),
            ...(parsed.package.keywords !== undefined ? { keywords: boundedStringList(parsed.package.keywords, 'package.keywords') } : {}),
        };
    }

    const categories: Record<string, string> = {};
    if (parsed.categories !== undefined) {
        if (!isRecord(parsed.categories)) throw new Error('package locale categories must be an object');
        for (const [categoryId, label] of Object.entries(parsed.categories)) {
            // Bundled/legacy toolboxes historically used their visible
            // category name as the lookup key (for example, "模拟传感").
            // Accept that bounded presentation alias while preferring stable
            // ASCII ids for new package authors.
            assertSafeCategoryKey(categoryId, 'package locale categories');
            categories[categoryId] = boundedText(label, `categories.${categoryId}`, true);
        }
    }

    const blocks: Record<string, BlockPackageBlockLocale> = {};
    if (parsed.blocks !== undefined) {
        if (!isRecord(parsed.blocks)) throw new Error('package locale blocks must be an object');
        for (const [blockType, blockLocale] of Object.entries(parsed.blocks)) {
            assertSafeKey(blockType, 'package locale blocks');
            blocks[blockType] = parseBlockLocale(blockLocale, `blocks.${blockType}`);
        }
    }
    return {
        ...(typeof parsed.$schema === 'string' ? { $schema: parsed.$schema } : {}),
        locale,
        ...(packageData ? { package: packageData } : {}),
        ...(Object.keys(categories).length > 0 ? { categories } : {}),
        ...(Object.keys(blocks).length > 0 ? { blocks } : {}),
    };
}

/** Discover locale file stems without trusting an author-maintained list. */
export function discoverPackageLocales(fileNames: readonly string[]): string[] {
    const locales = new Map<string, string>();
    for (const fileName of fileNames) {
        const rawName = String(fileName || '').replace(/\\/g, '/');
        if (rawName.includes('/')) continue;
        const base = rawName;
        const match = /^([A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)\.json$/i.exec(base);
        if (!match) continue;
        const locale = normalizeLocale(match[1]);
        if (locale) locales.set(normalizedLocaleKey(locale), locale);
    }
    return [...locales.values()].sort((left, right) => left.localeCompare(right));
}

const manifestDefaultLocale = (manifest: unknown): string => {
    if (!isRecord(manifest)) return '';
    const candidate = manifest.defaultLocale ?? manifest.default_locale;
    return normalizeLocale(candidate);
};

/**
 * Build a package locale bundle. The returned maps and documents are detached
 * from caller-owned objects, so resolving a locale cannot mutate the machine
 * package definition.
 */
export function createBlockPackageLocaleBundle(
    documents: Iterable<BlockPackageLocaleDocument>,
    defaultLocale?: string,
    legacy = false,
): BlockPackageLocaleBundle {
    const locales: Record<string, BlockPackageLocaleDocument> = {};
    for (const document of documents) {
        const locale = normalizeLocale(document?.locale);
        if (!locale) continue;
        const key = normalizedLocaleKey(locale);
        if (locales[key]) throw new Error(`duplicate package locale: ${locale}`);
        locales[key] = structuredClone(document);
    }
    const available = Object.values(locales).map(document => document.locale);
    const requestedDefault = normalizeLocale(defaultLocale);
    if (requestedDefault && !locales[normalizedLocaleKey(requestedDefault)]) {
        throw new Error(`package defaultLocale ${requestedDefault} has no locale document`);
    }
    if (!requestedDefault && available.length > 0 && !legacy) {
        throw new Error('package locale must declare defaultLocale');
    }
    const resolvedDefault = requestedDefault || available.slice().sort((a, b) => a.localeCompare(b))[0] || null;
    return {
        defaultLocale: resolvedDefault,
        locales,
        legacy: Boolean(legacy || available.length === 0),
    };
}

/** Alias kept intentionally small for package loader call sites. */
export const createPackageLocaleBundle = createBlockPackageLocaleBundle;

/** Build a legacy single-locale adapter from the machine definition itself. */
export function adaptLegacyPackageLocale(manifest: BlockPackageManifest | Record<string, unknown>): BlockPackageLocaleBundle {
    return createBlockPackageLocaleBundle([], manifestDefaultLocale(manifest), true);
}

const machineBlocks = (manifest: unknown): BlockManifestEntry[] => {
    if (!isRecord(manifest) || !Array.isArray(manifest.blocks)) return [];
    return manifest.blocks.filter((block): block is BlockManifestEntry => isRecord(block) && typeof block.type === 'string');
};

const machineString = (manifest: unknown, ...keys: string[]): string => {
    if (!isRecord(manifest)) return '';
    for (const key of keys) {
        const value = text(manifest[key]);
        if (value) return value;
    }
    return '';
};

const machineKeywords = (manifest: unknown): string[] => {
    if (!isRecord(manifest)) return [];
    return Array.isArray(manifest.keywords)
        ? [...new Set(manifest.keywords.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean))]
        : [];
};

const machineFieldOptions = (field: BlockManifestField): Array<{ label: string; value: string }> => (
    Array.isArray(field.options)
        ? field.options
            .filter(option => option && typeof option.value === 'string')
            .map(option => ({ label: String(option.label ?? option.value), value: String(option.value) }))
        : []
);

const blockFallbackName = (block: BlockManifestEntry): string => text(block.display_name) || block.type;

/**
 * Resolve a presentation view for one package. Locale resolution is strictly:
 * requested locale -> package default locale -> raw machine text.
 */
export function resolveBlockPackagePresentation(
    manifest: BlockPackageManifest | Record<string, unknown>,
    bundle: BlockPackageLocaleBundle | null | undefined,
    requestedLocale?: string,
): ResolvedBlockPackagePresentation {
    const requested = normalizeLocale(requestedLocale);
    const requestedDocument = requested && bundle?.locales[normalizedLocaleKey(requested)];
    const defaultDocument = bundle?.defaultLocale
        ? bundle.locales[normalizedLocaleKey(bundle.defaultLocale)]
        : undefined;
    const document = requestedDocument || defaultDocument;
    const source: PackageLocaleResolutionSource = requestedDocument
        ? 'requested'
        : defaultDocument
            ? 'default'
            : 'raw';
    const locale = document?.locale || null;
    const packageLocale = document?.package;
    const packageDisplayName = packageLocale?.displayName || machineString(manifest, 'display_name', 'displayName', 'name') || machineString(manifest, 'id') || 'Block package';
    const packageDescription = packageLocale?.description || machineString(manifest, 'description');
    const packageKeywords = packageLocale?.keywords || machineKeywords(manifest);
    const categories = Object.freeze({ ...(document?.categories || {}) });
    const blocks: Record<string, ResolvedBlockPackageBlock> = {};

    for (const block of machineBlocks(manifest)) {
        const type = String(block.type);
        const localized = document?.blocks?.[type];
        const fields = Array.isArray(block.fields) ? block.fields.map((field) => {
            const localizedField = localized?.fields?.[field.name];
            const options = machineFieldOptions(field).map(option => ({
                // Option values are copied exactly; only their human label is replaced.
                value: option.value,
                label: localizedField?.options?.[option.value] || option.label,
            }));
            return {
                name: field.name,
                label: localizedField?.label || text(field.description) || field.name,
                options,
            };
        }) : [];
        blocks[type] = {
            type,
            displayName: localized?.displayName || localized?.message || blockFallbackName(block),
            message: localized?.message || localized?.displayName || blockFallbackName(block),
            description: localized?.description || text(block.description) || blockFallbackName(block),
            tooltip: localized?.tooltip || localized?.description || text(block.description) || blockFallbackName(block),
            ...(text(block.category)
                ? { category: localized?.category || categories[text(block.category)] || text(block.category) }
                : {}),
            fields,
        };
    }

    return {
        locale,
        source,
        package: {
            displayName: packageDisplayName,
            description: packageDescription,
            keywords: [...packageKeywords],
        },
        categories,
        blocks: Object.freeze(blocks),
    };
}

/** Short alias used by runtime/package-loader call sites. */
export const resolvePackagePresentation = resolveBlockPackagePresentation;

/** Return a detached machine + presentation runtime view without mutation. */
export function createBlockPackageRuntimeView(
    manifest: BlockPackageManifest | Record<string, unknown>,
    bundle: BlockPackageLocaleBundle | null | undefined,
    requestedLocale?: string,
): {
    machinePackage: Record<string, unknown>;
    presentation: ResolvedBlockPackagePresentation;
} {
    const machinePackage = structuredClone(manifest as Record<string, unknown>);
    return {
        machinePackage,
        presentation: resolveBlockPackagePresentation(machinePackage, bundle, requestedLocale),
    };
}

/**
 * Apply a package locale to declarative Blockly JSON without changing any
 * machine-facing definition. Only message text, tooltip text, field labels,
 * and dropdown option labels are presentation data. Field names, option
 * values, block types, inputs, and defaults are copied exactly.
 *
 * This helper intentionally validates message placeholders before replacing
 * message0. A malformed translation must never alter the connection layout.
 */
export function localizeDeclarativeBlockDefinitions(
    blockJson: unknown,
    manifest: BlockPackageManifest | Record<string, unknown> | null | undefined,
    bundle: BlockPackageLocaleBundle | null | undefined,
    requestedLocale?: string,
): any {
    if (!manifest || !bundle || !Object.keys(bundle.locales || {}).length) return blockJson;

    const presentation = resolveBlockPackagePresentation(manifest, bundle, requestedLocale);
    if (!presentation.locale) return blockJson;

    const localeDocument = Object.values(bundle.locales).find((document) => (
        document.locale.toLowerCase() === presentation.locale?.toLowerCase()
    ));
    if (!localeDocument?.blocks) return blockJson;

    const cloneValue = (value: unknown): any => {
        if (typeof structuredClone === 'function') {
            try { return structuredClone(value); } catch { /* use JSON fallback */ }
        }
        try { return JSON.parse(JSON.stringify(value)); } catch { return value; }
    };
    const cloned = cloneValue(blockJson);
    const definitions: any[] = Array.isArray(cloned)
        ? cloned
        : Array.isArray(cloned?.blocks)
            ? cloned.blocks
            : cloned && typeof cloned === 'object' && typeof cloned.type === 'string'
                ? [cloned]
                : [];
    if (!definitions.length) return cloned;

    const messageSlots = (value: unknown): string[] => (
        typeof value === 'string'
            ? (value.match(/%\d+/g) || []).sort()
            : []
    );
    const sameMessageSlots = (left: unknown, right: unknown): boolean => {
        const a = messageSlots(left);
        const b = messageSlots(right);
        return a.length === b.length && a.every((slot, index) => slot === b[index]);
    };

    for (const definition of definitions) {
        if (!definition || typeof definition !== 'object') continue;
        const type = String(definition.type || '').trim();
        if (!type) continue;
        const localized = localeDocument.blocks[type];
        if (!localized) continue;

        if (typeof localized.message === 'string'
            && (typeof definition.message0 !== 'string'
                || sameMessageSlots(definition.message0, localized.message))) {
            definition.message0 = localized.message;
        } else if (typeof localized.message === 'string' && typeof definition.message0 === 'string') {
            // Keep the raw message when placeholders do not match. This is a
            // presentation fallback, never a reason to reject a package.
            console.warn(`[BlockPackageLocale] Ignored message translation with incompatible slots for ${type}`);
        }
        if (typeof localized.tooltip === 'string') definition.tooltip = localized.tooltip;

        const localizedFields = localized.fields || {};
        for (const argKey of Object.keys(definition).filter((key) => /^args\d+$/.test(key))) {
            if (!Array.isArray(definition[argKey])) continue;
            definition[argKey] = definition[argKey].map((rawArg: any) => {
                if (!rawArg || typeof rawArg !== 'object') return rawArg;
                const fieldName = String(rawArg.name || '').trim();
                const fieldLocale = fieldName ? localizedFields[fieldName] : undefined;
                if (!fieldLocale) return rawArg;
                const nextArg = { ...rawArg };

                // field_label text is presentation-only. Do not touch
                // field_input.text/value: those are serialized defaults.
                const fieldType = String(nextArg.type || '').toLowerCase();
                if (typeof fieldLocale.label === 'string'
                    && (fieldType === 'field_label' || fieldType === 'field_label_serializable')) {
                    nextArg.text = fieldLocale.label;
                }

                // Keep dropdown option values byte-for-byte stable while
                // replacing only their visible labels.
                if (fieldLocale.options && Array.isArray(nextArg.options)) {
                    nextArg.options = nextArg.options.map((option: any) => {
                        if (!Array.isArray(option) || option.length < 2) return option;
                        const value = String(option[1] ?? '');
                        const label = fieldLocale.options?.[value];
                        return label ? [label, option[1], ...option.slice(2)] : option;
                    });
                }
                return nextArg;
            });
        }
    }

    return cloned;
}
