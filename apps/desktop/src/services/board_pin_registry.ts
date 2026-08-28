import {
    normalizePinCodeToken,
    UNDECLARED_PIN_CODE_TOKEN,
} from './pin_code_token';

export type BoardPinDropdownOption = [string, string];

export interface BoardPinDropdownIdentity {
    fqbn: string;
    packageId?: string | null;
    isCustom?: boolean;
}

interface BoardPinDropdownRegistration {
    pins: BoardPinDropdownEntry[];
    isCustom: boolean;
}

interface BoardPinDropdownEntry {
    option: BoardPinDropdownOption;
    /** `null` means the publisher did not declare capability evidence. */
    capabilities: string[] | null;
}

export type BoardPinCapability = 'digital' | 'analog' | 'pwm';

export const UNDECLARED_BOARD_PIN: BoardPinDropdownOption = [
    '未声明引脚',
    UNDECLARED_PIN_CODE_TOKEN,
];

const clean = (value: unknown): string => String(value ?? '').trim();

export const boardPinDropdownKey = (
    fqbn: string,
    packageId?: string | null,
): string => {
    const target = clean(fqbn);
    const packageKey = clean(packageId) || target;
    // Length-prefixing prevents delimiter text inside an FQBN/package id from
    // producing an accidental cache collision.
    return `${target.length}:${target}${packageKey.length}:${packageKey}`;
};

const normalizeCapabilities = (value: unknown): string[] | null => {
    if (!Array.isArray(value) || value.length === 0) return null;
    const seen = new Set<string>();
    const result: string[] = [];
    for (const item of value) {
        if (typeof item !== 'string') continue;
        const capability = item.trim().toLocaleLowerCase('en-US').replace(/_/g, '-');
        if (!capability || seen.has(capability)) continue;
        seen.add(capability);
        result.push(capability);
    }
    return result.length ? result : null;
};

const normalizeBoardPinDropdownEntries = (pins: unknown): BoardPinDropdownEntry[] => {
    if (!Array.isArray(pins)) return [];
    const seen = new Set<string>();
    const normalized: BoardPinDropdownEntry[] = [];
    for (const pin of pins) {
        let label = '';
        let value = '';
        let capabilities: string[] | null = null;
        if (typeof pin === 'string') {
            label = clean(pin);
            value = normalizePinCodeToken(pin);
        } else if (Array.isArray(pin)) {
            label = clean(pin[0]);
            const rawValue = pin[1] == null || clean(pin[1]) === '' ? pin[0] : pin[1];
            value = normalizePinCodeToken(rawValue);
        } else if (pin && typeof pin === 'object') {
            const item = pin as Record<string, unknown>;
            label = clean(item.label || item.name || item.key);
            const rawValue = [item.value, item.id, item.val].find(candidate => (
                (typeof candidate === 'string' && candidate.trim().length > 0)
                || typeof candidate === 'number'
            ));
            value = normalizePinCodeToken(rawValue ?? label);
            capabilities = normalizeCapabilities(item.capabilities);
        }
        const identity = value.toLocaleLowerCase('en-US');
        if (!label || !value || seen.has(identity)) continue;
        seen.add(identity);
        normalized.push({ option: [label, value], capabilities });
    }
    return normalized;
};

export const normalizeBoardPinDropdownOptions = (pins: unknown): BoardPinDropdownOption[] => (
    normalizeBoardPinDropdownEntries(pins).map(entry => [entry.option[0], entry.option[1]])
);

const CAPABILITY_FAMILIES: Readonly<Record<BoardPinCapability, ReadonlySet<string>>> = Object.freeze({
    digital: new Set(['digital', 'gpio', 'digital-input', 'digital-output']),
    analog: new Set(['analog', 'adc', 'analog-input']),
    pwm: new Set(['pwm', 'analog-output']),
});

const unknownCapabilityLabel = (label: string): string => `${label}（能力未声明）`;

/**
 * Exact package-aware pin dropdown registry. Compiler FQBN and CK package id
 * are intentionally separate: two carrier-board packages may compile through
 * the same Arduino target while declaring different physical pins.
 */
export class BoardPinDropdownRegistry {
    private readonly registrations = new Map<string, BoardPinDropdownRegistration>();
    private active: Required<BoardPinDropdownIdentity> = {
        fqbn: 'esp32:esp32:esp32c5',
        packageId: 'esp32:esp32:esp32c5',
        isCustom: false,
    };

    activate(identity: BoardPinDropdownIdentity): void {
        const fqbn = clean(identity.fqbn);
        const packageId = clean(identity.packageId) || fqbn;
        this.active = { fqbn, packageId, isCustom: identity.isCustom === true };
    }

    getActiveIdentity(): Required<BoardPinDropdownIdentity> {
        return { ...this.active };
    }

    register(identity: BoardPinDropdownIdentity, pins: unknown): void {
        const fqbn = clean(identity.fqbn);
        const packageId = clean(identity.packageId) || fqbn;
        this.registrations.set(boardPinDropdownKey(fqbn, packageId), {
            pins: normalizeBoardPinDropdownEntries(pins),
            isCustom: identity.isCustom === true,
        });
    }

    resolve(staticOptions: unknown): BoardPinDropdownOption[] {
        const key = boardPinDropdownKey(this.active.fqbn, this.active.packageId);
        const exact = this.registrations.get(key);
        if (exact?.pins.length) {
            return exact.pins.map(entry => [entry.option[0], entry.option[1]]);
        }

        // A custom board with an empty or not-yet-loaded pin declaration must
        // never borrow the built-in pin table merely because its FQBN matches.
        if (this.active.isCustom || exact?.isCustom) {
            return [[UNDECLARED_BOARD_PIN[0], UNDECLARED_BOARD_PIN[1]]];
        }

        const fallback = normalizeBoardPinDropdownOptions(staticOptions);
        return fallback.length
            ? fallback
            : [[UNDECLARED_BOARD_PIN[0], UNDECLARED_BOARD_PIN[1]]];
    }

    /**
     * Resolve one template family for an exact compiler target + package id.
     * Capability-free catalogs remain usable but are visibly marked unknown;
     * a partially annotated catalog includes only explicitly matching pins.
     */
    resolveCapability(
        identity: BoardPinDropdownIdentity,
        capability: BoardPinCapability,
        staticOptions: unknown = [],
    ): BoardPinDropdownOption[] {
        const fqbn = clean(identity.fqbn);
        const packageId = clean(identity.packageId) || fqbn;
        const exact = this.registrations.get(boardPinDropdownKey(fqbn, packageId));
        if (exact?.pins.length) {
            const hasAnyCapabilityEvidence = exact.pins.some(entry => entry.capabilities !== null);
            if (!hasAnyCapabilityEvidence) {
                return exact.pins.map(entry => [
                    unknownCapabilityLabel(entry.option[0]),
                    entry.option[1],
                ]);
            }
            const accepted = CAPABILITY_FAMILIES[capability];
            const matched = exact.pins.filter(entry => (
                entry.capabilities?.some(value => accepted.has(value)) === true
            ));
            return matched.length
                ? matched.map(entry => [entry.option[0], entry.option[1]])
                : [[UNDECLARED_BOARD_PIN[0], UNDECLARED_BOARD_PIN[1]]];
        }

        if (identity.isCustom === true || exact?.isCustom) {
            return [[UNDECLARED_BOARD_PIN[0], UNDECLARED_BOARD_PIN[1]]];
        }
        const fallback = normalizeBoardPinDropdownEntries(staticOptions);
        return fallback.length
            ? fallback.map(entry => [unknownCapabilityLabel(entry.option[0]), entry.option[1]])
            : [[UNDECLARED_BOARD_PIN[0], UNDECLARED_BOARD_PIN[1]]];
    }
}

/** Shared exact-package registry used by Blockly and extension template expansion. */
export const BOARD_PIN_DROPDOWN_REGISTRY = new BoardPinDropdownRegistry();
