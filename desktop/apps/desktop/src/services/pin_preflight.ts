import type { BlockSearchEntry } from '../types/library';
import { compatLiteralField, isConvertedField, isDeclarativeAnalysisBlock } from './blockly_compat_analysis';
import {
    normalizePinCodeToken,
    UNDECLARED_PIN_CODE_TOKEN,
} from './pin_code_token';

export type PinPreflightSeverity = 'blocker' | 'warning' | 'notice';
export type PinResolution = 'known' | 'unknown' | 'invalid';
export type PinLiteralSource = 'board_selector' | 'number_literal' | 'text_literal' | 'block_field' | 'fixed_declaration';
export type PinUnknownReason = 'missing_input' | 'dynamic_expression' | 'invalid_literal';

export type PinSharingMode = 'exclusive' | 'shared' | 'board-defined';
export type PinCatalogFilter = 'all' | 'used' | 'risk' | 'available';

export interface PinRiskCondition {
    options?: Record<string, string | string[]>;
    features?: string[];
}

export interface PinRiskEvidence {
    kind?: string;
    reference?: string;
    locator?: string;
    sha256?: string;
}

export interface PinRiskDeclaration {
    code: string;
    severity: PinPreflightSeverity;
    title: string;
    detail?: string;
    roles?: string[];
    when?: PinRiskCondition;
}

export interface PinConnectorPosition {
    id: string;
    side?: 'left' | 'right' | 'top' | 'bottom';
    position?: number;
}

export interface PinPreflightBoardPin {
    label: string;
    value: string;
    aliases?: string[];
    capabilities?: string[];
    risks?: PinRiskDeclaration[];
    reserved_by?: string | string[];
    reservedBy?: string | string[];
    sharing?: PinSharingMode;
    source?: string;
    evidence?: PinRiskEvidence[];
    connector?: PinConnectorPosition;
}

export interface PinPreflightBoard {
    name: string;
    fqbn: string;
    pins: PinPreflightBoardPin[];
    packageId?: string;
    isCustom?: boolean;
    /** `verified` means CK may enforce explicit blocker declarations. */
    pinEvidenceLevel?: 'verified' | 'publisher' | 'basic';
}

export interface PinBlockLike {
    id: string;
    type: string;
    isInFlyout?: boolean;
    getFieldValue?: (name: string) => unknown;
    getInputTargetBlock?: (name: string) => PinBlockLike | null;
    /** Blockly runtime fields; optional so deterministic service tests stay lightweight. */
    inputList?: Array<{
        fieldRow?: Array<{
            getValue?: () => unknown;
            getText?: () => unknown;
            value_?: unknown;
        }>;
    }>;
    /** Test/adapter-friendly field snapshot used by some extension loaders. */
    fields?: Record<string, unknown>;
}

export interface PinWorkspaceLike {
    getAllBlocks: (ordered?: boolean) => PinBlockLike[];
}

export interface PinRoleRule {
    inputName?: string;
    fieldName?: string;
    fixedValue?: string | number;
    sourceId?: string;
    label: string;
    kind?: string;
    access?: string;
    sharing?: PinSharingMode;
    capabilities?: readonly string[];
}

export interface PinDistinctRule {
    inputs: readonly [string, string];
    message: string;
}

export interface PinBlockRule {
    label: string;
    pins: readonly PinRoleRule[];
    distinct?: readonly PinDistinctRule[];
}

/**
 * Explicit first-party registry. Quality-gated package rules may be supplied
 * separately, but a field name alone is never treated as pin metadata.
 */
export const BUILTIN_PIN_BLOCK_RULES: Readonly<Record<string, PinBlockRule>> = Object.freeze({
    set_pin_mode: {
        label: '设置管脚模式',
        pins: [{ inputName: 'PIN', label: '管脚', kind: 'gpio', access: 'read-write', capabilities: ['digital'] }],
    },
    write_digital: {
        label: '数字输出',
        pins: [{ inputName: 'PIN', label: '输出管脚', kind: 'gpio', access: 'write', capabilities: ['digital-output'] }],
    },
    io_digital_write: {
        label: '数字输出',
        pins: [{ inputName: 'PIN', label: '输出管脚', kind: 'gpio', access: 'write', capabilities: ['digital-output'] }],
    },
    io_digital_read: {
        label: '数字输入',
        pins: [{ inputName: 'PIN', label: '输入管脚', kind: 'gpio', access: 'read', capabilities: ['digital-input'] }],
    },
    io_analog_write: {
        label: '模拟输出',
        pins: [{ inputName: 'PIN', label: 'PWM 管脚', kind: 'pwm', access: 'write', capabilities: ['pwm'] }],
    },
    io_analog_read: {
        label: '模拟输入',
        pins: [{ inputName: 'PIN', label: '模拟管脚', kind: 'adc', access: 'read', capabilities: ['adc'] }],
    },
    io_soft_pwm_write: {
        label: '软件模拟输出',
        pins: [{ inputName: 'PIN', label: 'PWM 管脚', kind: 'gpio', access: 'write', capabilities: ['digital-output'] }],
    },
    io_soft_pwm_stop: {
        label: '停止软件模拟输出',
        pins: [{ inputName: 'PIN', label: 'PWM 管脚', kind: 'gpio', access: 'write', capabilities: ['digital-output'] }],
    },
    io_multi_button_event: {
        label: '多功能按键',
        pins: [{ inputName: 'PIN', label: '按键管脚', kind: 'gpio', access: 'read', capabilities: ['digital-input'] }],
    },
    io_hardware_interrupt_event: {
        label: '硬件中断',
        pins: [{ inputName: 'PIN', label: '中断管脚', kind: 'interrupt', access: 'read', capabilities: ['interrupt'] }],
    },
    io_hardware_interrupt_detach: {
        label: '取消硬件中断',
        pins: [{ inputName: 'PIN', label: '中断管脚', kind: 'interrupt', access: 'read', capabilities: ['interrupt'] }],
    },
    io_software_interrupt_event: {
        label: '软件中断',
        pins: [{ inputName: 'PIN', label: '中断管脚', kind: 'interrupt', access: 'read', capabilities: ['interrupt'] }],
    },
    io_software_interrupt_cancel: {
        label: '取消软件中断',
        pins: [{ inputName: 'PIN', label: '中断管脚', kind: 'interrupt', access: 'read', capabilities: ['interrupt'] }],
    },
    io_pulse_in: {
        label: '读取脉冲长度',
        pins: [{ inputName: 'PIN', label: '信号管脚', kind: 'gpio', access: 'read', capabilities: ['digital-input'] }],
    },
    io_pulse_in_timeout: {
        label: '限时读取脉冲',
        pins: [{ inputName: 'PIN', label: '信号管脚', kind: 'gpio', access: 'read', capabilities: ['digital-input'] }],
    },
    io_pulse_in_long: {
        label: '读取长脉冲',
        pins: [{ inputName: 'PIN', label: '信号管脚', kind: 'gpio', access: 'read', capabilities: ['digital-input'] }],
    },
    io_shift_out: {
        label: 'ShiftOut',
        pins: [
            { inputName: 'DATA_PIN', label: '数据管脚', kind: 'gpio', access: 'write', capabilities: ['digital-output'] },
            { inputName: 'CLOCK_PIN', label: '时钟管脚', kind: 'gpio', access: 'write', capabilities: ['digital-output'] },
        ],
        distinct: [{
            inputs: ['DATA_PIN', 'CLOCK_PIN'],
            message: 'ShiftOut 的数据管脚和时钟管脚不能相同。',
        }],
    },
    io_shift_in: {
        label: 'ShiftIn',
        pins: [
            { inputName: 'DATA_PIN', label: '数据管脚', kind: 'gpio', access: 'read', capabilities: ['digital-input'] },
            { inputName: 'CLOCK_PIN', label: '时钟管脚', kind: 'gpio', access: 'write', capabilities: ['digital-output'] },
        ],
        distinct: [{
            inputs: ['DATA_PIN', 'CLOCK_PIN'],
            message: 'ShiftIn 的数据管脚和时钟管脚不能相同。',
        }],
    },
    write_servo: {
        label: '舵机',
        pins: [{ inputName: 'PIN', label: '信号管脚', kind: 'pwm', access: 'write', sharing: 'exclusive', capabilities: ['pwm'] }],
    },
    serial_setup_with_pins: {
        label: '按引脚初始化串口',
        pins: [
            { inputName: 'RX', label: 'RX', kind: 'uart', access: 'read', sharing: 'exclusive', capabilities: ['uart-rx'] },
            { inputName: 'TX', label: 'TX', kind: 'uart', access: 'write', sharing: 'exclusive', capabilities: ['uart-tx'] },
        ],
        distinct: [{
            inputs: ['RX', 'TX'],
            message: '同一个硬件串口的 RX 和 TX 管脚不能相同。',
        }],
    },
});

const PACKAGE_PIN_RESOURCE_KINDS = new Set(['gpio', 'adc', 'pwm', 'interrupt']);

/**
 * Converts only explicit v2 hardware declarations into deterministic pin
 * rules. Adapted v1 metadata and inferred field names never qualify.
 */
export const pinBlockRulesFromCatalog = (
    entries: readonly BlockSearchEntry[],
): Readonly<Record<string, PinBlockRule>> => {
    const rules: Record<string, PinBlockRule> = {};
    for (const entry of entries) {
        if (
            entry.metadata_source !== 'v2'
            || !entry.type
            || BUILTIN_PIN_BLOCK_RULES[entry.type]
            || !Array.isArray(entry.hardware?.resources)
        ) continue;
        const seen = new Set<string>();
        const pins = entry.hardware.resources.flatMap((resource): PinRoleRule[] => {
            const source = resource.source;
            const sourceName = String(source?.name || '').trim();
            const fixed = source?.kind === 'fixed' && source.value !== undefined;
            const sourceId = fixed ? `fixed:${resource.id || source.value}` : `${source?.kind}:${sourceName}`;
            if (
                !PACKAGE_PIN_RESOURCE_KINDS.has(resource.kind)
                || !source
                || (!fixed && (!sourceName || !['input', 'field'].includes(source.kind)))
                || seen.has(sourceId)
            ) return [];
            seen.add(sourceId);
            return [{
                ...(fixed ? { fixedValue: source.value, sourceId }
                    : source.kind === 'input' ? { inputName: sourceName } : { fieldName: sourceName }),
                label: resource.description || resource.id || sourceName,
                kind: resource.kind,
                access: resource.access,
                sharing: resource.sharing,
                capabilities: Array.isArray(resource.capabilities) ? resource.capabilities : undefined,
            }];
        });
        if (pins.length === 0) continue;
        rules[entry.type] = {
            label: entry.display_name || entry.type,
            pins,
        };
    }
    return Object.freeze(rules);
};

export interface PinUsage {
    /** Presentation role; never used as a compiler or workspace identity. */
    roleId?: string;
    id: string;
    blockId: string;
    blockType: string;
    blockLabel: string;
    inputName: string;
    roleLabel: string;
    resolution: PinResolution;
    value: string | null;
    boardLabel: string | null;
    literalSource: PinLiteralSource | null;
    unknownReason: PinUnknownReason | null;
    expressionType: string | null;
    resourceKind: string | null;
    access: string | null;
    sharing: PinSharingMode | null;
    requiredCapabilities: string[];
}

export type PinPreflightIssueCode =
    | 'unsupported-board'
    | 'missing-trusted-pin-catalog'
    | 'same-block-pin-collision'
    | 'pin-not-on-board'
    | 'pin-capability-mismatch'
    | 'pin-capability-unknown'
    | 'pin-reserved'
    | 'pin-risk'
    | 'exclusive-pin-reused'
    | 'missing-pin-input'
    | 'dynamic-pin-expression'
    | 'invalid-pin-literal'
    | 'library-hardware-uncovered'
    | 'undeclared-pin-sentinel';

export interface PinPreflightIssue {
    id: string;
    code: PinPreflightIssueCode;
    severity: PinPreflightSeverity;
    title: string;
    detail: string;
    blockId: string | null;
    usageIds: string[];
}

export interface PinUsageGroup {
    value: string;
    boardLabel: string | null;
    usages: PinUsage[];
}

/** Aggregate references without treating repeated reads/writes as conflicts. */
export const summarizePinReferences = (usages: readonly PinUsage[]) => {
    const roles = new Map<string, PinUsage[]>();
    for (const usage of usages) {
        const role = usage.roleId || (usage.requiredCapabilities.includes('digital-output') ? 'digital-output'
            : usage.requiredCapabilities.includes('digital-input') ? 'digital-input'
                : usage.resourceKind || 'unknown');
        roles.set(role, [...(roles.get(role) || []), usage]);
    }
    // Only a declared input/output mismatch is called a role conflict. Other
    // combinations can be valid shared buses or sequential uses and stay unknown.
    const conflictCount = (roles.has('digital-input') && roles.has('digital-output'))
        || (roles.size > 1 && usages.some(usage => usage.sharing === 'exclusive')) ? 1 : 0;
    return { referenceCount: usages.length, roleCount: roles.size, conflictCount,
        roles: Array.from(roles, ([id, references]) => ({ id, references })) };
};

export interface PinCatalogEntry extends PinPreflightBoardPin {
    aliases: string[];
    capabilities: string[];
    risks: PinRiskDeclaration[];
    activeRisks: PinRiskDeclaration[];
    reservedBy: string[];
    sharing: PinSharingMode;
    usages: PinUsage[];
    evidenceLevel: 'verified' | 'publisher' | 'basic';
}

export interface PinPreflightReport {
    status: 'ready' | 'unsupported-board';
    boardFqbn: string;
    boardBaseFqbn: string;
    boardName: string | null;
    canCompile: boolean;
    analyzedBlockCount: number;
    ignoredBlockCount: number;
    usages: PinUsage[];
    groups: PinUsageGroup[];
    catalog: PinCatalogEntry[];
    pinEvidenceLevel: 'verified' | 'publisher' | 'basic';
    issues: PinPreflightIssue[];
    blockers: PinPreflightIssue[];
    warnings: PinPreflightIssue[];
    notices: PinPreflightIssue[];
}

export interface AnalyzePinPreflightInput {
    workspace: PinWorkspaceLike | null | undefined;
    boardFqbn: string;
    officialBoards: readonly PinPreflightBoard[];
    boardOptions?: Readonly<Record<string, string>>;
    /** Optional generated/source override used to detect library-backed features. */
    code?: string;
    /** When supplied, this exact package wins over another board sharing its FQBN. */
    boardPackageId?: string | null;
    /**
     * Explicit rules derived from a quality-gated package contract. Merely
     * naming a field PIN never opts a third-party block into this analysis.
     * Built-in rules always win when a package attempts to reuse a type.
     */
    blockRules?: Readonly<Record<string, PinBlockRule>>;
    /** Hydrated package declarations; used to disclose absent/partial coverage. */
    blockCatalog?: readonly BlockSearchEntry[];
}

export interface PinCatalogSearch {
    query?: string;
    filter?: PinCatalogFilter;
}

type ExtractedPin =
    | {
        kind: 'known';
        value: string;
        source: PinLiteralSource;
    }
    | {
        kind: 'unknown';
        reason: PinUnknownReason;
        source: PinLiteralSource | null;
        expressionType: string | null;
    };

const baseFqbn = (fqbn: string): string => String(fqbn || '')
    .split(':')
    .slice(0, 3)
    .join(':');

const readField = (block: PinBlockLike, name: string): unknown => {
    try {
        return block.getFieldValue?.(name);
    } catch {
        return null;
    }
};

const inputTarget = (block: PinBlockLike, inputName: string): PinBlockLike | null => {
    try {
        return block.getInputTargetBlock?.(inputName) || null;
    } catch {
        return null;
    }
};

const normalizePinToken = (raw: unknown): string | null => {
    const token = normalizePinCodeToken(raw);
    return token || null;
};

const blockContainsUndeclaredPinSentinel = (block: PinBlockLike): boolean => {
    const isSentinel = (value: unknown): boolean => String(value ?? '').trim() === UNDECLARED_PIN_CODE_TOKEN;
    if (block.fields && Object.values(block.fields).some(isSentinel)) return true;
    for (const input of block.inputList || []) {
        for (const field of input.fieldRow || []) {
            let value: unknown = field.value_;
            try {
                value = field.getValue?.() ?? field.getText?.() ?? value;
            } catch {
                // A broken third-party field is not evidence of a valid pin.
            }
            if (isSentinel(value)) return true;
        }
    }
    return false;
};

const pinLookupKey = (raw: unknown): string | null => {
    const token = normalizePinToken(raw);
    return token == null ? null : token.toLocaleLowerCase();
};

const cleanStringList = (value: unknown): string[] => {
    const source = Array.isArray(value) ? value : (typeof value === 'string' ? [value] : []);
    return Array.from(new Set(source.map(item => String(item || '').trim()).filter(Boolean)));
};

const riskConditionMatches = (
    condition: PinRiskCondition | undefined,
    options: Readonly<Record<string, string>>,
    activeFeatures: ReadonlySet<string>,
): boolean => {
    const expected = condition?.options;
    const optionsMatch = !expected || Object.keys(expected).length === 0
        ? true
        : Object.entries(expected).every(([key, rawAllowed]) => {
        const allowed = Array.isArray(rawAllowed) ? rawAllowed : [rawAllowed];
        return allowed.map(value => String(value)).includes(String(options[key] ?? ''));
    });
    if (!optionsMatch) return false;
    const expectedFeatures = cleanStringList(condition?.features)
        .map(value => value.toLocaleLowerCase());
    return expectedFeatures.every(feature => activeFeatures.has(feature));
};

const activeWorkspaceFeatures = (
    blocks: readonly PinBlockLike[],
    codeHint = '',
): ReadonlySet<string> => {
    const features = new Set<string>();
    for (const block of blocks) {
        const type = String(block.type || '').trim().toLocaleLowerCase();
        if (type === 'wifi_connect' || type === 'wifi_wait_until_ready'
            || type === 'wifi_local_ip' || type === 'wifi_set_protocol'
            || type === 'wifi_get_rssi' || type === 'wifi_get_channel') {
            features.add('wifi');
        }
    }
    // A source override or a legacy code-only project may not have a WiFi
    // block in the Blockly workspace. Treat the explicit WiFi include/API as
    // the same project feature, without guessing from a pin label.
    if (/\#include\s*[<"](?:WiFi|ESP8266WiFi)\.h[>"]|\bWiFi\s*\./i.test(String(codeHint || ''))) {
        features.add('wifi');
    }
    return features;
};

const normalizedCapability = (value: string): string => value.trim().toLocaleLowerCase().replace(/_/g, '-');

const CAPABILITY_FAMILIES: Readonly<Record<string, readonly string[]>> = Object.freeze({
    digital: ['digital', 'gpio', 'digital-input', 'digital-output'],
    'digital-input': ['digital-input', 'digital', 'gpio', 'input'],
    'digital-output': ['digital-output', 'digital', 'gpio', 'output'],
    adc: ['adc', 'analog', 'analog-input'],
    'analog-input': ['adc', 'analog', 'analog-input'],
    pwm: ['pwm', 'analog-output'],
    interrupt: ['interrupt', 'external-interrupt'],
    'uart-rx': ['uart-rx', 'uart', 'rx'],
    'uart-tx': ['uart-tx', 'uart', 'tx'],
});

type PinCapabilitySupport = 'supported' | 'unsupported' | 'unknown';

const requiredCapabilitySupport = (
    available: readonly string[],
    required: string,
): PinCapabilitySupport => {
    if (available.length === 0) return 'unknown';
    const availableSet = new Set(available.map(normalizedCapability));
    const normalized = normalizedCapability(required);
    const accepted = CAPABILITY_FAMILIES[normalized] || [normalized];
    return accepted.some(value => availableSet.has(value)) ? 'supported' : 'unsupported';
};

const riskMatchesRole = (risk: PinRiskDeclaration, role: PinRoleRule): boolean => {
    const requested = cleanStringList(risk.roles).map(value => value.toLocaleLowerCase());
    if (requested.length === 0) return true;
    const roleTokens = [
        role.kind,
        role.access,
        role.inputName,
        role.fieldName,
        role.label,
        ...(role.capabilities || []),
    ].map(value => String(value || '').trim().toLocaleLowerCase()).filter(Boolean);
    return requested.some(value => roleTokens.includes(value));
};

const extractPin = (target: PinBlockLike | null): ExtractedPin => {
    if (!target) {
        return {
            kind: 'unknown',
            reason: 'missing_input',
            source: null,
            expressionType: null,
        };
    }

    if (target.type === 'board_pin_selector') {
        const value = normalizePinToken(readField(target, 'PIN'));
        return value
            ? { kind: 'known', value, source: 'board_selector' }
            : {
                kind: 'unknown',
                reason: 'invalid_literal',
                source: 'board_selector',
                expressionType: target.type,
            };
    }

    const compat = compatLiteralField(target);
    if (target.type === 'math_number' || compat?.kind === 'number') {
        const raw = readField(target, compat?.field || 'NUM');
        const rawText = String(raw ?? '').trim();
        const numeric = rawText ? Number(rawText) : Number.NaN;
        if (Number.isSafeInteger(numeric) && numeric >= 0) {
            return { kind: 'known', value: String(numeric), source: 'number_literal' };
        }
        return {
            kind: 'unknown',
            reason: 'invalid_literal',
            source: 'number_literal',
            expressionType: target.type,
        };
    }

    if (target.type === 'text' || compat?.kind === 'dropdown') {
        const value = normalizePinToken(readField(target, compat?.field || 'TEXT'));
        return value
            ? { kind: 'known', value, source: 'text_literal' }
            : {
                kind: 'unknown',
                reason: 'invalid_literal',
                source: 'text_literal',
                expressionType: target.type,
            };
    }

    return {
        kind: 'unknown',
        reason: 'dynamic_expression',
        source: null,
        expressionType: target.type || null,
    };
};

const extractPinForRole = (block: PinBlockLike, role: PinRoleRule): ExtractedPin => {
    if (role.fixedValue !== undefined) {
        const value = normalizePinToken(role.fixedValue);
        return value ? { kind: 'known', value, source: 'fixed_declaration' }
            : { kind: 'unknown', reason: 'invalid_literal', source: 'fixed_declaration', expressionType: block.type };
    }
    if (role.fieldName) {
        if (isConvertedField(block, role.fieldName)) {
            return extractPin(inputTarget(block, role.fieldName));
        }
        const value = normalizePinToken(readField(block, role.fieldName));
        return value
            ? { kind: 'known', value, source: 'block_field' }
            : {
                kind: 'unknown',
                reason: 'invalid_literal',
                source: 'block_field',
                expressionType: block.type,
            };
    }
    return extractPin(inputTarget(block, role.inputName || ''));
};

const naturalPinOrder = (left: string, right: string): number => left.localeCompare(
    right,
    undefined,
    { numeric: true, sensitivity: 'base' },
);

const CONNECTOR_SIDE_ORDER: Readonly<Record<NonNullable<PinConnectorPosition['side']>, number>> = Object.freeze({
    left: 0,
    right: 1,
    top: 2,
    bottom: 3,
});

const issueForUnknownUsage = (usage: PinUsage): PinPreflightIssue => {
    if (usage.unknownReason === 'missing_input') {
        return {
            id: `missing:${usage.id}`,
            code: 'missing-pin-input',
            severity: 'warning',
            title: `${usage.blockLabel}缺少${usage.roleLabel}`,
            detail: '该输入未连接。当前生成器可能使用默认值，但体检不会替你猜测实际接线。',
            blockId: usage.blockId,
            usageIds: [usage.id],
        };
    }
    if (usage.unknownReason === 'invalid_literal') {
        return {
            id: `invalid:${usage.id}`,
            code: 'invalid-pin-literal',
            severity: 'warning',
            title: `${usage.blockLabel}的${usage.roleLabel}不是有效引脚字面量`,
            detail: '请使用板卡引脚选择积木、非负整数，或 A0 这类模拟引脚常量。',
            blockId: usage.blockId,
            usageIds: [usage.id],
        };
    }
    return {
        id: `dynamic:${usage.id}`,
        code: 'dynamic-pin-expression',
        severity: 'notice',
        title: `${usage.blockLabel}的${usage.roleLabel}将在运行时确定`,
        detail: `连接的是${usage.expressionType || '动态表达式'}，本轮只记录为未知，不据此判断冲突。`,
        blockId: usage.blockId,
        usageIds: [usage.id],
    };
};

const splitIssues = (report: Omit<PinPreflightReport, 'blockers' | 'warnings' | 'notices' | 'canCompile'>): PinPreflightReport => {
    const blockers = report.issues.filter(issue => issue.severity === 'blocker');
    const warnings = report.issues.filter(issue => issue.severity === 'warning');
    const notices = report.issues.filter(issue => issue.severity === 'notice');
    return {
        ...report,
        blockers,
        warnings,
        notices,
        canCompile: blockers.length === 0,
    };
};

/**
 * Read-only, deterministic pin analysis for boards with an explicit pin list
 * and blocks with registered rules. Cross-block pin reuse is normally only
 * listed in occupancy groups because shared buses and repeated reads are
 * valid; an explicit `exclusive` declaration adds a warning, never a guess.
 */
export const analyzePinPreflight = ({
    workspace,
    boardFqbn,
    officialBoards,
    boardOptions = {},
    boardPackageId = null,
    blockRules = {},
    blockCatalog = [],
    code = '',
}: AnalyzePinPreflightInput): PinPreflightReport => {
    const normalizedFqbn = String(boardFqbn || '').trim();
    const normalizedBaseFqbn = baseFqbn(normalizedFqbn);
    const requestedPackageId = String(boardPackageId || '').trim();
    const board = requestedPackageId
        ? officialBoards.find(candidate => {
            const candidatePackageId = String(
                candidate.packageId
                || (candidate.isCustom ? '' : baseFqbn(candidate.fqbn)),
            ).trim();
            return candidatePackageId === requestedPackageId
                && baseFqbn(candidate.fqbn) === normalizedBaseFqbn;
        }) || null
        : officialBoards.find(candidate => candidate.fqbn === normalizedFqbn)
            || officialBoards.find(candidate => candidate.fqbn === normalizedBaseFqbn)
            || null;

    const ruleFor = (blockType: string): PinBlockRule | undefined => (
        BUILTIN_PIN_BLOCK_RULES[blockType] || blockRules[blockType]
    );
    const blocks = workspace?.getAllBlocks(false) || [];
    const activeFeatures = activeWorkspaceFeatures(blocks, code);
    const registeredBlocks = blocks.filter(block => !block.isInFlyout && Boolean(ruleFor(block.type)));
    const declarationCatalog = new Map(blockCatalog.map(entry => [entry.type, entry]));
    const coverageIssues: PinPreflightIssue[] = blocks.flatMap(block => {
        if (block.isInFlyout || BUILTIN_PIN_BLOCK_RULES[block.type] || compatLiteralField(block)) return [];
        const entry = declarationCatalog.get(block.type);
        // The toolbox catalog also lists built-in math/control/print blocks.
        // Missing library metadata is a package gap, not a claim about those operands.
        if (!entry?.library_id && !isDeclarativeAnalysisBlock(block)) return [];
        const hardware = entry?.hardware;
        const missing = entry?.metadata_source !== 'v2' || !Array.isArray(hardware?.resources);
        const unsupportedSource = hardware?.resources?.some(resource => PACKAGE_PIN_RESOURCE_KINDS.has(resource.kind)
            && !['field', 'input', 'fixed'].includes(resource.source?.kind || ''));
        if (!missing && hardware?.claims?.coverage === 'full' && !unsupportedSource) return [];
        return [{ id: `library-coverage:${block.id}`, code: 'library-hardware-uncovered', severity: 'notice',
            title: missing ? '库未声明硬件检查信息' : '库的硬件检查尚未完整覆盖',
            detail: `${entry?.display_name || block.type}：${missing
                ? '库需要在 hardware.resources / hardware.claims 中声明资源用途。'
                : '当前只检查能解析的声明；缺失声明、板卡默认连接或其他未覆盖资源不能视为通过。'}`,
            blockId: block.id, usageIds: [] }];
    });
    const sentinelBlocks = blocks.filter(block => (
        !block.isInFlyout && blockContainsUndeclaredPinSentinel(block)
    ));

    if (!board) {
        const issues: PinPreflightIssue[] = [{
            id: 'unsupported-board',
            code: 'unsupported-board',
            severity: 'notice',
            title: '当前板卡暂不执行引脚体检',
            detail: '当前板卡没有可校验的引脚清单。第三方板卡必须在已通过门禁的板卡包中声明 pins，体检不会按名称猜测。',
            blockId: null,
            usageIds: [],
        }];
        for (const block of sentinelBlocks) {
            issues.push({
                id: `undeclared-pin:${block.id}`,
                code: 'undeclared-pin-sentinel',
                severity: 'blocker',
                title: '积木仍在使用“未声明引脚”占位值',
                detail: '当前板卡没有可信的引脚值可供该积木生成源码。请选择声明了 pins 的板卡包，或先移除这个引脚积木。',
                blockId: block.id,
                usageIds: [],
            });
        }
        if (registeredBlocks.length > 0 && sentinelBlocks.length === 0) {
            issues.push({
                id: 'missing-trusted-pin-catalog',
                code: 'missing-trusted-pin-catalog',
                severity: 'blocker',
                title: '缺少可信引脚清单',
                detail: `工作区有 ${registeredBlocks.length} 个使用引脚资源的积木，但当前板卡包未提供通过质量门禁的 pins 元数据。为防止错误引脚进入生成代码，已阻止编译。`,
                blockId: registeredBlocks[0]?.id || null,
                usageIds: [],
            });
        }
        return splitIssues({
            status: 'unsupported-board',
            boardFqbn: normalizedFqbn,
            boardBaseFqbn: normalizedBaseFqbn,
            boardName: null,
            analyzedBlockCount: 0,
            ignoredBlockCount: Math.max(0, blocks.length - registeredBlocks.length),
            usages: [],
            groups: [],
            catalog: [],
            pinEvidenceLevel: 'basic',
            issues: [...issues, ...coverageIssues],
        });
    }
    const pinEvidenceLevel = board.pinEvidenceLevel || (board.isCustom ? 'publisher' : 'basic');
    const normalizedPins = board.pins.flatMap((pin): PinCatalogEntry[] => {
        const value = normalizePinToken(pin.value);
        const label = String(pin.label || '').trim();
        if (!value || !label) return [];
        const aliases = cleanStringList(pin.aliases).filter(alias => pinLookupKey(alias) !== pinLookupKey(value));
        const capabilities = cleanStringList(pin.capabilities);
        const risks = Array.isArray(pin.risks)
            ? pin.risks.filter(risk => risk && risk.code && risk.title && ['blocker', 'warning', 'notice'].includes(risk.severity))
            : [];
        const reservedBy = cleanStringList(pin.reserved_by ?? pin.reservedBy);
        return [{
            ...pin,
            label,
            value,
            aliases,
            capabilities,
            risks,
            activeRisks: risks.filter(risk => riskConditionMatches(risk.when, boardOptions, activeFeatures)),
            reservedBy,
            sharing: pin.sharing || 'board-defined',
            usages: [],
            evidenceLevel: pinEvidenceLevel,
        }];
    });
    const pinLookup = new Map<string, PinCatalogEntry | null>();
    for (const pin of normalizedPins) {
        for (const token of [pin.value, ...pin.aliases]) {
            const key = pinLookupKey(token);
            if (!key) continue;
            const previous = pinLookup.get(key);
            pinLookup.set(key, previous && previous.value !== pin.value ? null : pin);
        }
    }
    const usages: PinUsage[] = [];
    const issues: PinPreflightIssue[] = [...coverageIssues];
    for (const block of sentinelBlocks) {
        issues.push({
            id: `undeclared-pin:${block.id}`,
            code: 'undeclared-pin-sentinel',
            severity: 'blocker',
            title: '积木仍在使用“未声明引脚”占位值',
            detail: '该值只用于界面提示，不能进入 C/C++。请从当前精确板卡包的引脚列表重新选择。',
            blockId: block.id,
            usageIds: [],
        });
    }

    for (const block of registeredBlocks) {
        const rule = ruleFor(block.type)!;
        const usagesByInput = new Map<string, PinUsage>();

        for (const role of rule.pins) {
            const sourceName = role.inputName || role.fieldName || role.sourceId || '';
            if (!sourceName) continue;
            const extracted = extractPinForRole(block, role);
            const known = extracted.kind === 'known';
            const matchedPin = known ? pinLookup.get(pinLookupKey(extracted.value) || '') || null : null;
            const boardLabel = matchedPin?.label || null;
            const resolution: PinResolution = known
                ? (matchedPin ? 'known' : 'invalid')
                : 'unknown';
            const usage: PinUsage = {
                roleId: block.type === 'set_pin_mode'
                    ? (block.getFieldValue?.('MODE') === 'OUTPUT' ? 'digital-output'
                        : ['INPUT', 'INPUT_PULLUP', 'INPUT_PULLDOWN'].includes(String(block.getFieldValue?.('MODE')))
                            ? 'digital-input' : 'unknown')
                    : undefined,
                id: `${block.id}:${sourceName}`,
                blockId: block.id,
                blockType: block.type,
                blockLabel: rule.label,
                inputName: sourceName,
                roleLabel: role.label,
                resolution,
                value: known ? matchedPin?.value || extracted.value : null,
                boardLabel,
                literalSource: extracted.kind === 'known' ? extracted.source : extracted.source,
                unknownReason: extracted.kind === 'unknown' ? extracted.reason : null,
                expressionType: extracted.kind === 'unknown' ? extracted.expressionType : null,
                resourceKind: role.kind || null,
                access: role.access || null,
                sharing: role.sharing || null,
                requiredCapabilities: cleanStringList(role.capabilities),
            };
            usages.push(usage);
            usagesByInput.set(sourceName, usage);

            if (usage.resolution === 'unknown') {
                issues.push(issueForUnknownUsage(usage));
            } else if (usage.resolution === 'invalid') {
                issues.push({
                    id: `not-on-board:${usage.id}`,
                    code: 'pin-not-on-board',
                    severity: 'warning',
                    title: `${usage.blockLabel}使用了板卡清单外的引脚 ${usage.value}`,
                    detail: `当前官方板卡数据为“${board.name}”。这可能是别名或接线错误，第一阶段只提示，不阻断编译。`,
                    blockId: usage.blockId,
                    usageIds: [usage.id],
                });
            } else if (matchedPin) {
                const unsupportedCapabilities = usage.requiredCapabilities.filter(required => (
                    requiredCapabilitySupport(matchedPin.capabilities, required) === 'unsupported'
                ));
                const unknownCapabilities = usage.requiredCapabilities.filter(required => (
                    requiredCapabilitySupport(matchedPin.capabilities, required) === 'unknown'
                ));
                if (unsupportedCapabilities.length > 0) {
                    issues.push({
                        id: `capability:${usage.id}:${unsupportedCapabilities.join(',')}`,
                        code: 'pin-capability-mismatch',
                        severity: 'warning',
                        title: `${matchedPin.label}的能力清单不包含 ${unsupportedCapabilities.join(' / ')}`,
                        detail: `积木“${usage.blockLabel}”需要 ${unsupportedCapabilities.join('、')}。该结论来自当前板卡包的结构化引脚表；请核对接线或板卡资料。`,
                        blockId: usage.blockId,
                        usageIds: [usage.id],
                    });
                }
                if (unknownCapabilities.length > 0) {
                    issues.push({
                        id: `capability-unknown:${usage.id}:${unknownCapabilities.join(',')}`,
                        code: 'pin-capability-unknown',
                        severity: 'notice',
                        title: `${matchedPin.label}尚未声明 ${unknownCapabilities.join(' / ')} 能力证据`,
                        detail: `积木“${usage.blockLabel}”需要这些能力；当前保持未知且不阻止编译，不会把“未声明”冒充为“支持”。`,
                        blockId: usage.blockId,
                        usageIds: [usage.id],
                    });
                }
                if (matchedPin.reservedBy.length > 0) {
                    issues.push({
                        id: `reserved:${usage.id}`,
                        code: 'pin-reserved',
                        severity: 'warning',
                        title: `${matchedPin.label}已保留给 ${matchedPin.reservedBy.join('、')}`,
                        detail: '保留资源由当前板卡引脚合同明确声明。CK 先提示风险，不会仅凭发布者自报静默阻止编译。',
                        blockId: usage.blockId,
                        usageIds: [usage.id],
                    });
                }
                for (const risk of matchedPin.activeRisks.filter(item => riskMatchesRole(item, role))) {
                    const effectiveSeverity = risk.severity === 'blocker' && pinEvidenceLevel !== 'verified'
                        ? 'warning'
                        : risk.severity;
                    issues.push({
                        id: `risk:${risk.code}:${usage.id}`,
                        code: 'pin-risk',
                        severity: effectiveSeverity,
                        title: `${matchedPin.label}：${risk.title}`,
                        detail: `${risk.detail || '当前用法命中了板卡声明的引脚风险。'}${risk.severity === 'blocker' && pinEvidenceLevel !== 'verified' ? ' 此数据尚未达到 CK 已验证级别，因此只警告、不阻止。' : ''}`,
                        blockId: usage.blockId,
                        usageIds: [usage.id],
                    });
                }
            }
        }

        for (const distinct of rule.distinct || []) {
            const left = usagesByInput.get(distinct.inputs[0]);
            const right = usagesByInput.get(distinct.inputs[1]);
            if (!left || !right || left.value == null || right.value == null) continue;
            if (left.value !== right.value) continue;
            issues.push({
                id: `collision:${block.id}:${distinct.inputs.join(':')}`,
                code: 'same-block-pin-collision',
                severity: 'blocker',
                title: `${rule.label}内部引脚重复`,
                detail: `${distinct.message} 当前均为 ${left.value}。`,
                blockId: block.id,
                usageIds: [left.id, right.id],
            });
        }
    }

    const groupMap = new Map<string, PinUsage[]>();
    for (const usage of usages) {
        if (usage.value == null) continue;
        const existing = groupMap.get(usage.value) || [];
        existing.push(usage);
        groupMap.set(usage.value, existing);
    }
    const groups: PinUsageGroup[] = Array.from(groupMap.entries())
        .sort(([left], [right]) => naturalPinOrder(left, right))
        .map(([value, groupedUsages]) => ({
            value,
            boardLabel: groupedUsages.find(usage => usage.boardLabel)?.boardLabel || null,
            usages: groupedUsages,
        }));

    for (const group of groups) {
        if (group.usages.length < 2) continue;
        if (summarizePinReferences(group.usages).roleCount < 2) continue;
        const pin = normalizedPins.find(candidate => candidate.value === group.value);
        const hasExplicitExclusiveUse = pin?.sharing === 'exclusive'
            || group.usages.some(usage => usage.sharing === 'exclusive');
        if (!hasExplicitExclusiveUse) continue;
        issues.push({
            id: `exclusive:${group.value}`,
            code: 'exclusive-pin-reused',
            severity: 'warning',
            title: `${pin?.label || group.value}存在多个独占用法`,
            detail: '至少一项结构化资源声明要求独占。共享总线仍应声明为 shared；当前只警告并列出所有占用位置。',
            blockId: group.usages[0]?.blockId || null,
            usageIds: group.usages.map(usage => usage.id),
        });
    }

    const catalog = normalizedPins
        .map(pin => ({
            ...pin,
            usages: groupMap.get(pin.value) || [],
        }))
        .sort((left, right) => {
            const leftConnector = left.connector;
            const rightConnector = right.connector;
            if (leftConnector && rightConnector) {
                const connectorOrder = naturalPinOrder(leftConnector.id, rightConnector.id);
                if (connectorOrder !== 0) return connectorOrder;
                const sideOrder = (leftConnector.side ? CONNECTOR_SIDE_ORDER[leftConnector.side] : 99)
                    - (rightConnector.side ? CONNECTOR_SIDE_ORDER[rightConnector.side] : 99);
                if (sideOrder !== 0) return sideOrder;
                if (leftConnector.position != null && rightConnector.position != null
                    && leftConnector.position !== rightConnector.position) {
                    return leftConnector.position - rightConnector.position;
                }
            }
            if (leftConnector && !rightConnector) return -1;
            if (!leftConnector && rightConnector) return 1;
            return naturalPinOrder(left.value, right.value);
        });

    return splitIssues({
        status: 'ready',
        boardFqbn: normalizedFqbn,
        boardBaseFqbn: board.fqbn,
        boardName: board.name,
        analyzedBlockCount: registeredBlocks.length,
        ignoredBlockCount: Math.max(0, blocks.filter(block => !block.isInFlyout).length - registeredBlocks.length),
        usages,
        groups,
        catalog,
        pinEvidenceLevel,
        issues,
    });
};

const pinSearchText = (pin: PinCatalogEntry): string => [
    pin.value,
    pin.label,
    ...pin.aliases,
    ...pin.capabilities,
    ...pin.reservedBy,
    pin.sharing,
    pin.source || '',
    pin.connector?.id || '',
    ...pin.risks.flatMap(risk => [risk.code, risk.title, risk.detail || '', ...(risk.roles || [])]),
    ...pin.usages.flatMap(usage => [usage.blockLabel, usage.roleLabel, usage.blockType]),
].join(' ').toLocaleLowerCase();

/** Deterministic search shared by the UI and tests; it never infers pin facts. */
export const filterPinCatalog = (
    catalog: readonly PinCatalogEntry[],
    { query = '', filter = 'all' }: PinCatalogSearch = {},
): PinCatalogEntry[] => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return catalog.filter(pin => {
        if (filter === 'used' && pin.usages.length === 0) return false;
        if (filter === 'risk' && pin.activeRisks.length === 0 && pin.reservedBy.length === 0) return false;
        // `available` is kept as the stable internal key, but means only
        // "currently unused". Missing risk metadata is unknown, not proof
        // that an electrical pin is safe for arbitrary use.
        if (filter === 'available' && pin.usages.length > 0) return false;
        return !normalizedQuery || pinSearchText(pin).includes(normalizedQuery);
    });
};
