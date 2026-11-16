import { baseBoardFqbn, composeBoardFqbn, parseBoardFqbnOptions } from './board_fqbn';
import type { PinPreflightBoard, PinPreflightBoardPin } from './pin_preflight';

export interface InstalledCorePinAliasSource {
    kind: 'installed-arduino-core-variant';
    fqbn: string;
    package: string;
    architecture: string;
    coreVersion: string;
    variant: string;
    file: 'pins_arduino.h';
    sha256: string;
}

export interface InstalledCorePinAliasCatalog {
    schemaVersion: 1;
    pins: ReadonlyMap<string, readonly string[]>;
    source: InstalledCorePinAliasSource;
}

const ALIAS_CACHE = new Map<string, InstalledCorePinAliasCatalog | null>();
const ALIAS_REQUESTS = new Map<string, Promise<InstalledCorePinAliasCatalog | null>>();
let aliasCacheGeneration = 0;
export const CORE_PIN_ALIAS_CACHE_INVALIDATED_EVENT = 'ck-core-pin-alias-cache-invalidated';

export class InstalledCorePinAliasCacheInvalidatedError extends Error {
    constructor(fqbn: string) {
        super(`Installed Core pin alias request invalidated for ${fqbn}`);
        this.name = 'InstalledCorePinAliasCacheInvalidatedError';
    }
}

const cleanText = (value: unknown, maxLength = 128): string => {
    if (typeof value !== 'string') return '';
    const clean = value.trim();
    return clean.length <= maxLength ? clean : '';
};

const canonicalResolvedFqbn = (fqbn: string): string => composeBoardFqbn(
    baseBoardFqbn(fqbn),
    parseBoardFqbnOptions(fqbn),
);

const sourceFromRaw = (raw: any): InstalledCorePinAliasSource | null => {
    const fqbn = cleanText(raw?.fqbn, 1024);
    const sha256 = cleanText(raw?.sha256, 64).toLowerCase();
    const file = cleanText(raw?.file, 64);
    if (
        cleanText(raw?.kind, 64) !== 'installed-arduino-core-variant'
        || !fqbn
        || file !== 'pins_arduino.h'
        || !/^[0-9a-f]{64}$/.test(sha256)
    ) return null;
    return {
        kind: 'installed-arduino-core-variant',
        fqbn,
        package: cleanText(raw?.package),
        architecture: cleanText(raw?.architecture),
        coreVersion: cleanText(raw?.core_version),
        variant: cleanText(raw?.variant),
        file: 'pins_arduino.h',
        sha256,
    };
};

/**
 * Accept only the bounded, versioned alias snapshot emitted by the desktop
 * backend. Unknown schema versions are ignored rather than guessed.
 */
export const installedCorePinAliasesFromDetails = (
    details: unknown,
    expectedFqbn: string,
): InstalledCorePinAliasCatalog | null => {
    const raw = (details as any)?.ck_pin_alias_catalog;
    if (raw?.schema_version !== 1 || !Array.isArray(raw?.pins) || raw.pins.length > 512) {
        return null;
    }
    const source = sourceFromRaw(raw.source);
    if (!source || canonicalResolvedFqbn(source.fqbn) !== canonicalResolvedFqbn(expectedFqbn)) {
        return null;
    }

    const pins = new Map<string, string[]>();
    for (const item of raw.pins) {
        const value = cleanText(item?.value, 16);
        if (!/^(?:0|[1-9][0-9]{0,4})$/.test(value) || !Array.isArray(item?.aliases)) continue;
        const aliases: string[] = [];
        for (const alias of (item.aliases as unknown[]).slice(0, 128)) {
            const clean = cleanText(alias, 64);
            if (/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(clean)) aliases.push(clean);
        }
        const unique = [...new Set(aliases)];
        if (unique.length > 0) pins.set(value, unique);
    }
    return pins.size > 0 ? { schemaVersion: 1, pins, source } : null;
};

/** Full resolved FQBN cache: option-dependent variants must stay isolated. */
export const getInstalledCorePinAliasesCached = async (
    effectiveFqbn: string,
): Promise<InstalledCorePinAliasCatalog | null> => {
    const resolvedFqbn = canonicalResolvedFqbn(effectiveFqbn);
    const key = resolvedFqbn;
    if (!resolvedFqbn) return null;
    if (ALIAS_CACHE.has(key)) return ALIAS_CACHE.get(key) || null;
    const pending = ALIAS_REQUESTS.get(key);
    if (pending) return pending;

    const requestGeneration = aliasCacheGeneration;
    const request = (async () => {
        const { invoke } = await import('@tauri-apps/api/core');
        const raw = await invoke('get_installed_core_pin_aliases', { fqbn: resolvedFqbn });
        if (requestGeneration !== aliasCacheGeneration) {
            throw new InstalledCorePinAliasCacheInvalidatedError(resolvedFqbn);
        }
        const parsed = JSON.parse(String(raw || 'null'));
        const catalog = installedCorePinAliasesFromDetails(
            { ck_pin_alias_catalog: parsed },
            resolvedFqbn,
        );
        ALIAS_CACHE.set(key, catalog);
        return catalog;
    })();
    ALIAS_REQUESTS.set(key, request);
    try {
        return await request;
    } finally {
        if (ALIAS_REQUESTS.get(key) === request) ALIAS_REQUESTS.delete(key);
    }
};

export const clearInstalledCorePinAliasCache = (): void => {
    aliasCacheGeneration += 1;
    ALIAS_CACHE.clear();
    ALIAS_REQUESTS.clear();
    if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event(CORE_PIN_ALIAS_CACHE_INVALIDATED_EVENT));
    }
};

const mergeEvidence = (
    pin: PinPreflightBoardPin,
    catalog: InstalledCorePinAliasCatalog,
): PinPreflightBoardPin['evidence'] => {
    const evidence = Array.isArray(pin.evidence) ? [...pin.evidence] : [];
    if (!evidence.some(item => item.sha256?.toLowerCase() === catalog.source.sha256)) {
        const coreName = catalog.source.package || catalog.source.architecture || 'Arduino';
        evidence.push({
            kind: 'board-definition',
            reference: `${coreName}${catalog.source.coreVersion ? ` ${catalog.source.coreVersion}` : ''} pins_arduino.h`,
            locator: catalog.source.variant ? `variant:${catalog.source.variant}` : 'variant',
            sha256: catalog.source.sha256,
        });
    }
    return evidence;
};

/**
 * Merge installed-Core aliases into a built-in board catalog without
 * replacing any CK metadata. Custom/imported boards are intentionally left
 * untouched: their quality-gated package metadata is the source of truth.
 */
export const mergeInstalledCorePinAliases = (
    board: PinPreflightBoard,
    catalog: InstalledCorePinAliasCatalog | null,
): PinPreflightBoard => {
    if (!catalog || board.isCustom || baseBoardFqbn(board.fqbn) !== baseBoardFqbn(catalog.source.fqbn)) {
        return board;
    }
    const reverseAliases = new Map<string, Set<string>>();
    for (const [numericValue, aliases] of catalog.pins) {
        for (const alias of aliases) {
            const key = alias.toLowerCase();
            if (!reverseAliases.has(key)) reverseAliases.set(key, new Set());
            reverseAliases.get(key)?.add(numericValue);
        }
    }
    let changed = false;
    const sourceLabel = [
        catalog.source.package || catalog.source.architecture || 'Arduino Core',
        catalog.source.coreVersion,
        catalog.source.variant && `variant ${catalog.source.variant}`,
    ].filter(Boolean).join(' · ');
    const pins = board.pins.map(pin => {
        const boardValue = String(pin.value);
        let numericValue = catalog.pins.has(boardValue) ? boardValue : '';
        if (!numericValue) {
            const candidates = new Set<string>();
            for (const token of [boardValue, ...(pin.aliases || [])]) {
                for (const value of reverseAliases.get(token.toLowerCase()) || []) {
                    candidates.add(value);
                }
            }
            if (candidates.size === 1) numericValue = [...candidates][0];
        }
        const aliases = numericValue ? catalog.pins.get(numericValue) : undefined;
        if (!aliases?.length) return pin;
        const mergedAliases = [...new Set([
            ...(pin.aliases || []),
            ...aliases,
            ...(numericValue !== boardValue ? [numericValue] : []),
        ])];
        changed = true;
        return {
            ...pin,
            aliases: mergedAliases,
            source: pin.source || sourceLabel,
            evidence: mergeEvidence(pin, catalog),
        };
    });
    return changed ? { ...board, pins } : board;
};
