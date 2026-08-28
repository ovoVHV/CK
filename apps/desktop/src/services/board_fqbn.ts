import type { BoardOption } from '../types/board';

const FQBN_TOKEN_RE = /^[A-Za-z0-9_.-]+$/;

// Arduino AVR exposes these boards as a base FQBN while its selected Core
// defaults are menu values.  Keep the project-facing base identity, but make
// the compile identity complete so certificate lookup and cache keys match the
// exact target that Arduino CLI actually builds.  Explicit project options
// always take precedence (for example, Diecimila ATmega168).
const BUILTIN_AVR_DEFAULT_OPTIONS: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze({
    'arduino:avr:diecimila': Object.freeze({ cpu: 'atmega328' }),
    'arduino:avr:nano': Object.freeze({ cpu: 'atmega328' }),
    'arduino:avr:mega': Object.freeze({ cpu: 'atmega2560' }),
});

export const normalizeBoardOptionValue = (raw: unknown): string | null => {
    if (raw === null || raw === undefined) return null;
    if (typeof raw === 'string') return raw.trim() || null;
    if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
    if (typeof raw === 'object') {
        const obj = raw as Record<string, unknown>;
        const candidate = obj.value ?? obj.id ?? obj.key ?? obj.name;
        if (typeof candidate === 'string') return candidate.trim() || null;
        if (typeof candidate === 'number' || typeof candidate === 'boolean') return String(candidate);
    }
    return null;
};

export const sanitizeBoardOptions = (
    input: Record<string, unknown> | null | undefined,
): Record<string, string> => {
    if (!input || typeof input !== 'object') return {};
    const out: Record<string, string> = {};
    for (const [rawKey, rawValue] of Object.entries(input)) {
        const key = String(rawKey || '').trim();
        if (!key || !FQBN_TOKEN_RE.test(key)) continue;
        const value = normalizeBoardOptionValue(rawValue);
        if (!value || !FQBN_TOKEN_RE.test(value)) continue;
        out[key] = value;
    }
    return out;
};

export const updateExplicitBoardOption = (
    currentInput: Record<string, unknown> | null | undefined,
    rawKey: string,
    rawValue: unknown,
    defaultsInput: Record<string, unknown> | null | undefined,
): Record<string, string> => {
    const current = sanitizeBoardOptions(currentInput);
    const defaults = sanitizeBoardOptions(defaultsInput);
    const key = String(rawKey || '').trim();
    const value = normalizeBoardOptionValue(rawValue);
    if (!key || !FQBN_TOKEN_RE.test(key) || !value || !FQBN_TOKEN_RE.test(value)) return current;
    if (defaults[key] === value) delete current[key];
    else current[key] = value;
    return current;
};

export const boardOptionsFallbackStatus = (
    explicitInput: Record<string, unknown> | null | undefined,
): 'core-default' | 'unverified' => (
    Object.keys(sanitizeBoardOptions(explicitInput)).length > 0 ? 'unverified' : 'core-default'
);

export const composeBoardFqbn = (
    fqbn: string,
    optionsInput: Record<string, unknown> | null | undefined,
): string => {
    const rawFqbn = String(fqbn || '').trim();
    if (!rawFqbn) return '';
    const options = sanitizeBoardOptions(optionsInput);
    const optionKeys = Object.keys(options).sort();
    const parts = rawFqbn.split(':');
    const baseFqbn = parts.length >= 3 ? parts.slice(0, 3).join(':') : rawFqbn;
    // Only inject a Core default when the caller supplied a base FQBN and no
    // explicit menu values. An inline option suffix is deliberately treated
    // as stale input by the existing API contract, just like other boards.
    const effectiveOptions = optionKeys.length > 0 || parts.length > 3
        ? options
        : (BUILTIN_AVR_DEFAULT_OPTIONS[baseFqbn] || options);
    const effectiveOptionKeys = Object.keys(effectiveOptions).sort();
    if (effectiveOptionKeys.length === 0) return baseFqbn;
    const optionsString = effectiveOptionKeys
        .map(key => `${key}=${effectiveOptions[key]}`)
        .join(',');
    return `${baseFqbn}:${optionsString}`;
};

export const parseBoardFqbnOptions = (fqbn: string): Record<string, string> => {
    const parts = String(fqbn || '').trim().split(':');
    if (parts.length <= 3) return {};
    const parsed: Record<string, unknown> = {};
    for (const token of parts.slice(3).join(':').split(',')) {
        const equals = token.indexOf('=');
        if (equals <= 0) continue;
        parsed[token.slice(0, equals).trim()] = token.slice(equals + 1).trim();
    }
    return sanitizeBoardOptions(parsed);
};

export const baseBoardFqbn = (fqbn: string): string => {
    const rawFqbn = String(fqbn || '').trim();
    const parts = rawFqbn.split(':');
    return parts.length >= 3 ? parts.slice(0, 3).join(':') : rawFqbn;
};

export interface ResolvedBoardOptionDefaults {
    defaults: Record<string, string>;
    allowedKeys: Set<string>;
    allowedValues: Map<string, Set<string>>;
}

/** Compiler-target plus board-package identity for option-schema caches. */
export const boardOptionSchemaCacheKey = (fqbn: string, boardPackageId?: string | null): string => {
    const base = baseBoardFqbn(fqbn).toLowerCase();
    const packageId = String(boardPackageId || '').trim() || base;
    return `${base}::${packageId}`;
};

/**
 * Overlay an imported board's declared menu constraints on the Arduino Core
 * menu schema. Package declarations may narrow Core values and select a
 * different default, but may never invent keys or values. A contradictory
 * declaration is rejected instead of silently falling back to another board
 * package's or the Core's defaults.
 */
export const mergeBoardConfigOptions = (
    coreConfigOptions: unknown,
    packageConfigOptions: unknown,
): BoardOption[] => {
    if (!Array.isArray(coreConfigOptions)) return [];
    const merged = coreConfigOptions.map(raw => {
        const option = raw as Partial<BoardOption>;
        return {
            ...option,
            option: String(option.option || '').trim(),
            option_label: String(option.option_label || option.option || '').trim(),
            values: Array.isArray(option.values)
                ? option.values.map(value => ({ ...value }))
                : [],
        } as BoardOption;
    }).filter(option => option.option && FQBN_TOKEN_RE.test(option.option));
    if (!Array.isArray(packageConfigOptions) || packageConfigOptions.length === 0) return merged;

    const coreIndex = new Map(merged.map((option, index) => [option.option, index]));
    const seenPackageKeys = new Set<string>();
    for (const rawPackageOption of packageConfigOptions) {
        const packageOption = rawPackageOption as Partial<BoardOption>;
        const key = String(packageOption?.option || '').trim();
        if (!key || !FQBN_TOKEN_RE.test(key) || seenPackageKeys.has(key)) {
            throw new Error(`Invalid or duplicate board-package menu: ${key || '(empty)'}`);
        }
        seenPackageKeys.add(key);
        const index = coreIndex.get(key);
        if (index === undefined) {
            throw new Error(`Board package declares menu ${key}, but the selected Core target does not provide it`);
        }
        if (!Array.isArray(packageOption.values) || packageOption.values.length === 0) {
            throw new Error(`Board package menu ${key} has no allowed values`);
        }

        const coreOption = merged[index];
        const coreValues = new Map(coreOption.values.flatMap(value => {
            const normalized = normalizeBoardOptionValue(value?.value);
            return normalized ? [[normalized, value] as const] : [];
        }));
        const packageValues = new Map<string, BoardOption['values'][number]>();
        for (const value of packageOption.values) {
            const normalized = normalizeBoardOptionValue(value?.value);
            if (!normalized || packageValues.has(normalized)) {
                throw new Error(`Board package menu ${key} contains an invalid or duplicate value`);
            }
            if (!coreValues.has(normalized)) {
                throw new Error(`Board package menu ${key} declares unsupported Core value ${normalized}`);
            }
            packageValues.set(normalized, value);
        }
        const packageSelected = [...packageValues.entries()]
            .filter(([, value]) => value?.selected === true)
            .map(([value]) => value);
        if (packageSelected.length > 1) {
            throw new Error(`Board package menu ${key} selects more than one default`);
        }
        const coreSelected = coreOption.values
            .filter(value => value?.selected === true)
            .map(value => normalizeBoardOptionValue(value?.value))
            .filter((value): value is string => Boolean(value));
        const selectedValue = packageSelected[0]
            || coreSelected.find(value => packageValues.has(value))
            || null;
        if (coreSelected.length > 0 && !selectedValue) {
            throw new Error(`Board package menu ${key} excludes the Core default without declaring a replacement`);
        }

        merged[index] = {
            option: key,
            option_label: String(packageOption.option_label || coreOption.option_label || key),
            values: [...packageValues.entries()].map(([value, packageValue]) => ({
                ...coreValues.get(value)!,
                ...packageValue,
                value,
                value_label: String(
                    packageValue.value_label
                    || coreValues.get(value)?.value_label
                    || value,
                ),
                selected: value === selectedValue,
            })),
        };
    }
    return merged;
};

export interface BoardOptionSwitchState {
    projectOptions: Record<string, string>;
    compileOptions: Record<string, string>;
    displayOptions: Record<string, string>;
    dropped: Record<string, string>;
    status: 'loading' | 'resolved';
}

/** A board switch never carries any project option from the previous board. */
export const createBoardOptionSwitchState = (
    cachedSchema: ResolvedBoardOptionDefaults | null,
    initialExplicitInput: Record<string, unknown> = {},
): BoardOptionSwitchState => {
    const projectOptions = sanitizeBoardOptions(initialExplicitInput);
    const resolution = cachedSchema
        ? resolveBoardOptionsWithDiagnostics(
            cachedSchema.defaults,
            projectOptions,
            cachedSchema.allowedKeys,
            cachedSchema.allowedValues,
        )
        : null;
    return {
        projectOptions,
        compileOptions: resolution?.explicitOptions || {},
        displayOptions: resolution?.options || {},
        dropped: resolution?.dropped || {},
        status: cachedSchema ? 'resolved' : 'loading',
    };
};

export interface BoardOptionResolution {
    /** Defaults plus validated explicit values, for complete read-only display. */
    options: Record<string, string>;
    /** Validated project/user values only, for compile/cache identity. */
    explicitOptions: Record<string, string>;
    dropped: Record<string, string>;
}

/**
 * Uses the core/board package's selected values as the authoritative defaults.
 * It never infers Flash or PSRAM capacity from a board or module name.
 */
export const extractSelectedBoardOptionDefaults = (
    configOptions: unknown,
): ResolvedBoardOptionDefaults => {
    const defaults: Record<string, string> = {};
    const allowedKeys = new Set<string>();
    const allowedValues = new Map<string, Set<string>>();
    if (!Array.isArray(configOptions)) return { defaults, allowedKeys, allowedValues };

    for (const rawOption of configOptions) {
        const option = rawOption as Partial<BoardOption>;
        const key = String(option?.option || '').trim();
        if (!key || !FQBN_TOKEN_RE.test(key) || !Array.isArray(option.values)) continue;
        allowedKeys.add(key);
        const values = new Set<string>();
        for (const rawValue of option.values) {
            const value = normalizeBoardOptionValue(rawValue?.value);
            if (value && FQBN_TOKEN_RE.test(value)) values.add(value);
        }
        allowedValues.set(key, values);
        const selected = option.values.find(value => value?.selected === true);
        const selectedValue = normalizeBoardOptionValue(selected?.value);
        if (selectedValue && values.has(selectedValue)) defaults[key] = selectedValue;
    }
    return { defaults, allowedKeys, allowedValues };
};

export const mergeBoardOptionSchemas = (
    coreConfigOptions: unknown,
    packageConfigOptions: unknown,
): ResolvedBoardOptionDefaults => extractSelectedBoardOptionDefaults(
    mergeBoardConfigOptions(coreConfigOptions, packageConfigOptions),
);

/** Merge saved/user choices over defaults, dropping options unsupported by this board. */
export const resolveBoardOptionsWithDiagnostics = (
    defaultsInput: Record<string, unknown> | null | undefined,
    explicitInput: Record<string, unknown> | null | undefined,
    allowedKeys: ReadonlySet<string>,
    allowedValues: ReadonlyMap<string, ReadonlySet<string>>,
): BoardOptionResolution => {
    const defaults = sanitizeBoardOptions(defaultsInput);
    const explicit = sanitizeBoardOptions(explicitInput);
    const resolved: Record<string, string> = {};
    const explicitOptions: Record<string, string> = {};
    const dropped: Record<string, string> = {};
    for (const [key, value] of Object.entries(defaults)) {
        if (allowedKeys.has(key) && allowedValues.get(key)?.has(value)) resolved[key] = value;
    }
    for (const [key, value] of Object.entries(explicit)) {
        if (allowedKeys.has(key) && allowedValues.get(key)?.has(value)) {
            resolved[key] = value;
            if (defaults[key] !== value) explicitOptions[key] = value;
        }
        else dropped[key] = value;
    }
    return { options: resolved, explicitOptions, dropped };
};

export const resolveBoardOptions = (
    defaultsInput: Record<string, unknown> | null | undefined,
    explicitInput: Record<string, unknown> | null | undefined,
    allowedKeys: ReadonlySet<string>,
    allowedValues: ReadonlyMap<string, ReadonlySet<string>>,
): Record<string, string> => resolveBoardOptionsWithDiagnostics(
    defaultsInput,
    explicitInput,
    allowedKeys,
    allowedValues,
).options;
