export type MigrationJsonPrimitive = string | number | boolean | null;

export interface MigrationJsonObject {
    [key: string]: MigrationJsonValue;
}

export type MigrationJsonValue = MigrationJsonPrimitive | MigrationJsonObject | MigrationJsonValue[];

export interface RenameBlockTypeOperation {
    op: 'renameBlockType';
    from: string;
    to: string;
}

export interface RenameFieldOperation {
    op: 'renameField';
    block_type: string;
    from: string;
    to: string;
}

export interface EnumValueMapping {
    from: MigrationJsonPrimitive;
    to: MigrationJsonPrimitive;
}

export interface MapEnumOperation {
    op: 'mapEnum';
    block_type: string;
    field: string;
    mappings: readonly EnumValueMapping[];
}

export type BlockPackageMigrationOperation =
    | RenameBlockTypeOperation
    | RenameFieldOperation
    | MapEnumOperation;

export interface BlockPackageMigrationStep {
    id: string;
    /** Exact SemVer or a restricted, whitespace-separated comparator AND range. */
    from: string;
    /** Exact SemVer destination; ranges are deliberately forbidden here. */
    to: string;
    operations: readonly BlockPackageMigrationOperation[];
}

export interface BlockPackageMigrationManifestV1 {
    schema_version: 1;
    package_id: string;
    migrations: readonly BlockPackageMigrationStep[];
}

export interface BlockPackageMigrationRequest {
    packageId: string;
    fromVersion: string;
    toVersion: string;
}

export type BlockPackageMigrationIssueCode =
    | 'PACKAGE_ID_MISMATCH'
    | 'NO_VERSION_PATH'
    | 'MULTIPLE_VERSION_PATHS'
    | 'VERSION_PATH_CYCLE'
    | 'MALFORMED_WORKSPACE_STRUCTURE'
    | 'CONFLICTING_OPERATIONS'
    | 'FIELD_NAME_COLLISION'
    | 'FIELD_CONTAINER_INVALID'
    | 'ENUM_VALUE_UNMAPPED'
    | 'ENUM_VALUE_INVALID';

export interface BlockPackageMigrationIssue {
    code: BlockPackageMigrationIssueCode;
    message: string;
    stepId?: string;
    operationIndex?: number;
    relatedOperationIndexes?: readonly number[];
    blockPath?: string;
    blockId?: string;
    propertyPath?: string;
    value?: MigrationJsonValue;
}

export interface BlockPackageMigrationChange {
    stepId: string;
    operationIndex: number;
    operation: BlockPackageMigrationOperation['op'];
    blockPath: string;
    blockId?: string;
    fromPath: string;
    toPath: string;
    before: MigrationJsonPrimitive;
    after: MigrationJsonPrimitive;
}

export interface ChangedMigrationBlock {
    path: string;
    id?: string;
    originalType: string;
    migratedType: string;
    changes: readonly BlockPackageMigrationChange[];
}

export interface MigrationOperationDetail {
    stepId: string;
    operationIndex: number;
    operation: BlockPackageMigrationOperation;
    status: 'applied' | 'no-match' | 'blocked';
    matchedBlockCount: number;
    changedBlockCount: number;
    unresolvedCount: number;
    ambiguousCount: number;
    changes: readonly BlockPackageMigrationChange[];
}

export interface MigrationPathStep {
    id: string;
    from: string;
    to: string;
    operationCount: number;
}

export interface BlockPackageMigrationPlan {
    status: 'ready' | 'blocked';
    canApply: boolean;
    packageId: string;
    fromVersion: string;
    toVersion: string;
    path: readonly MigrationPathStep[];
    changedBlockCount: number;
    changedBlocks: readonly ChangedMigrationBlock[];
    operationDetails: readonly MigrationOperationDetail[];
    unresolved: readonly BlockPackageMigrationIssue[];
    ambiguous: readonly BlockPackageMigrationIssue[];
    /**
     * A detached dry-run candidate. It may contain partial preview changes when
     * status is blocked and must never be persisted unless canApply is true.
     */
    outputWorkspace: MigrationJsonObject;
}

export interface BlockPackageMigrationApplication {
    workspace: MigrationJsonObject;
    plan: BlockPackageMigrationPlan;
}

export type BlockPackageMigrationValidationCode =
    | 'INVALID_MANIFEST'
    | 'INVALID_REQUEST'
    | 'INVALID_WORKSPACE';

export class BlockPackageMigrationValidationError extends Error {
    readonly code: BlockPackageMigrationValidationCode;
    readonly path: string;

    constructor(code: BlockPackageMigrationValidationCode, path: string, message: string) {
        super(`${message} (${path})`);
        this.name = 'BlockPackageMigrationValidationError';
        this.code = code;
        this.path = path;
    }
}

export class BlockPackageMigrationBlockedError extends Error {
    readonly plan: BlockPackageMigrationPlan;

    constructor(plan: BlockPackageMigrationPlan) {
        const codes = [...plan.unresolved, ...plan.ambiguous].map(issue => issue.code);
        super(`Blockly package migration is blocked: ${codes.join(', ') || 'unknown reason'}`);
        this.name = 'BlockPackageMigrationBlockedError';
        this.plan = plan;
    }
}

const PACKAGE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const COMPARATOR_PREFIX_RE = /^(<=|>=|<|>|=)/;

interface ParsedSemVer {
    source: string;
    major: string;
    minor: string;
    patch: string;
    prerelease: readonly string[];
}

interface VersionComparator {
    operator: '<' | '<=' | '=' | '>=' | '>';
    version: ParsedSemVer;
}

interface VersionSelector {
    source: string;
    comparators: readonly VersionComparator[];
}

function validationFailure(
    code: BlockPackageMigrationValidationCode,
    path: string,
    message: string,
): never {
    throw new BlockPackageMigrationValidationError(code, path, message);
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
    Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const hasOwn = (value: object, property: string): boolean => (
    Object.prototype.hasOwnProperty.call(value, property)
);

const requireExactKeys = (
    value: Record<string, unknown>,
    allowed: readonly string[],
    required: readonly string[],
    code: BlockPackageMigrationValidationCode,
    path: string,
): void => {
    const allowedSet = new Set(allowed);
    for (const key of Object.keys(value)) {
        if (!allowedSet.has(key)) {
            validationFailure(code, `${path}.${key}`, `Unknown property "${key}" is forbidden`);
        }
    }
    for (const key of required) {
        if (!hasOwn(value, key)) {
            validationFailure(code, path, `Required property "${key}" is missing`);
        }
    }
};

const requireString = (
    value: unknown,
    code: BlockPackageMigrationValidationCode,
    path: string,
    maximumLength: number,
): string => {
    if (
        typeof value !== 'string'
        || value.length === 0
        || value.length > maximumLength
        || value.trim() !== value
    ) {
        validationFailure(code, path, `Expected a non-empty string of at most ${maximumLength} characters without edge whitespace`);
    }
    return value;
};

const parseSemVer = (
    value: unknown,
    code: BlockPackageMigrationValidationCode,
    path: string,
): ParsedSemVer => {
    if (typeof value !== 'string') {
        validationFailure(code, path, 'Expected an exact SemVer string');
    }
    const match = SEMVER_RE.exec(value);
    if (!match) validationFailure(code, path, 'Expected an exact SemVer string');
    return {
        source: value,
        major: match[1],
        minor: match[2],
        patch: match[3],
        prerelease: match[4] ? match[4].split('.') : [],
    };
};

const parseVersionSelector = (
    value: unknown,
    code: BlockPackageMigrationValidationCode,
    path: string,
): VersionSelector => {
    if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
        validationFailure(code, path, 'Expected an exact SemVer or explicit comparator range');
    }

    if (SEMVER_RE.test(value)) {
        return {
            source: value,
            comparators: [{ operator: '=', version: parseSemVer(value, code, path) }],
        };
    }

    const tokens = value.split(/\s+/);
    const comparators = tokens.map((token, index): VersionComparator => {
        const prefix = COMPARATOR_PREFIX_RE.exec(token)?.[1] as VersionComparator['operator'] | undefined;
        if (!prefix) {
            validationFailure(code, `${path}[${index}]`, 'Ranges require explicit <, <=, =, >= or > comparators');
        }
        const versionText = token.slice(prefix.length);
        return {
            operator: prefix,
            version: parseSemVer(versionText, code, `${path}[${index}]`),
        };
    });
    if (comparators.length === 0) {
        validationFailure(code, path, 'A version selector cannot be empty');
    }
    return { source: value, comparators };
};

const compareNumericIdentifier = (left: string, right: string): number => {
    if (left.length !== right.length) return left.length < right.length ? -1 : 1;
    if (left === right) return 0;
    return left < right ? -1 : 1;
};

const compareSemVer = (left: ParsedSemVer, right: ParsedSemVer): number => {
    for (const key of ['major', 'minor', 'patch'] as const) {
        const comparison = compareNumericIdentifier(left[key], right[key]);
        if (comparison !== 0) return comparison;
    }

    if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
    if (left.prerelease.length === 0) return 1;
    if (right.prerelease.length === 0) return -1;

    const length = Math.max(left.prerelease.length, right.prerelease.length);
    for (let index = 0; index < length; index += 1) {
        const leftPart = left.prerelease[index];
        const rightPart = right.prerelease[index];
        if (leftPart === undefined) return -1;
        if (rightPart === undefined) return 1;
        if (leftPart === rightPart) continue;
        const leftNumeric = /^\d+$/.test(leftPart);
        const rightNumeric = /^\d+$/.test(rightPart);
        if (leftNumeric && rightNumeric) return compareNumericIdentifier(leftPart, rightPart);
        if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
        return leftPart < rightPart ? -1 : 1;
    }
    return 0;
};

const semVerKey = (version: ParsedSemVer): string => (
    `${version.major}.${version.minor}.${version.patch}`
    + (version.prerelease.length > 0 ? `-${version.prerelease.join('.')}` : '')
);

const selectorMatches = (selector: VersionSelector, version: ParsedSemVer): boolean => (
    selector.comparators.every(comparator => {
        const comparison = compareSemVer(version, comparator.version);
        switch (comparator.operator) {
            case '<': return comparison < 0;
            case '<=': return comparison <= 0;
            case '=': return comparison === 0;
            case '>=': return comparison >= 0;
            case '>': return comparison > 0;
        }
    })
);

const parseJsonScalar = (
    value: unknown,
    path: string,
): MigrationJsonPrimitive => {
    if (
        value === null
        || typeof value === 'string'
        || typeof value === 'boolean'
        || (typeof value === 'number' && Number.isFinite(value))
    ) {
        return value;
    }
    return validationFailure('INVALID_MANIFEST', path, 'Expected a finite JSON scalar');
};

const scalarKey = (value: MigrationJsonPrimitive): string => {
    if (value === null) return 'null';
    if (typeof value === 'number') return `number:${value === 0 ? 0 : value}`;
    return `${typeof value}:${String(value)}`;
};

const scalarEquals = (left: MigrationJsonPrimitive, right: MigrationJsonPrimitive): boolean => (
    left === right
);

const parseOperation = (
    raw: unknown,
    path: string,
): BlockPackageMigrationOperation => {
    if (!isRecord(raw)) validationFailure('INVALID_MANIFEST', path, 'Expected an operation object');
    const op = raw.op;

    if (op === 'renameBlockType') {
        requireExactKeys(raw, ['op', 'from', 'to'], ['op', 'from', 'to'], 'INVALID_MANIFEST', path);
        const from = requireString(raw.from, 'INVALID_MANIFEST', `${path}.from`, 256);
        const to = requireString(raw.to, 'INVALID_MANIFEST', `${path}.to`, 256);
        if (from === to) validationFailure('INVALID_MANIFEST', path, 'renameBlockType must change the type');
        return { op, from, to };
    }

    if (op === 'renameField') {
        requireExactKeys(
            raw,
            ['op', 'block_type', 'from', 'to'],
            ['op', 'block_type', 'from', 'to'],
            'INVALID_MANIFEST',
            path,
        );
        const blockType = requireString(raw.block_type, 'INVALID_MANIFEST', `${path}.block_type`, 256);
        const from = requireString(raw.from, 'INVALID_MANIFEST', `${path}.from`, 256);
        const to = requireString(raw.to, 'INVALID_MANIFEST', `${path}.to`, 256);
        if (from === to) validationFailure('INVALID_MANIFEST', path, 'renameField must change the field name');
        return { op, block_type: blockType, from, to };
    }

    if (op === 'mapEnum') {
        requireExactKeys(
            raw,
            ['op', 'block_type', 'field', 'mappings'],
            ['op', 'block_type', 'field', 'mappings'],
            'INVALID_MANIFEST',
            path,
        );
        const blockType = requireString(raw.block_type, 'INVALID_MANIFEST', `${path}.block_type`, 256);
        const field = requireString(raw.field, 'INVALID_MANIFEST', `${path}.field`, 256);
        if (!Array.isArray(raw.mappings) || raw.mappings.length === 0 || raw.mappings.length > 256) {
            validationFailure('INVALID_MANIFEST', `${path}.mappings`, 'Expected 1 to 256 enum mappings');
        }
        const seen = new Set<string>();
        const mappings = raw.mappings.map((mapping, index): EnumValueMapping => {
            const mappingPath = `${path}.mappings[${index}]`;
            if (!isRecord(mapping)) {
                validationFailure('INVALID_MANIFEST', mappingPath, 'Expected an enum mapping object');
            }
            requireExactKeys(
                mapping,
                ['from', 'to'],
                ['from', 'to'],
                'INVALID_MANIFEST',
                mappingPath,
            );
            const from = parseJsonScalar(mapping.from, `${mappingPath}.from`);
            const to = parseJsonScalar(mapping.to, `${mappingPath}.to`);
            const key = scalarKey(from);
            if (seen.has(key)) {
                validationFailure('INVALID_MANIFEST', `${mappingPath}.from`, 'Duplicate enum source value');
            }
            seen.add(key);
            return { from, to };
        });
        return { op, block_type: blockType, field, mappings };
    }

    return validationFailure(
        'INVALID_MANIFEST',
        `${path}.op`,
        'Only renameBlockType, renameField and mapEnum are supported',
    );
};

/** Runtime counterpart to ck-migrations.schema.json; returns a detached typed manifest. */
export const parseBlockPackageMigrationManifest = (
    raw: unknown,
): BlockPackageMigrationManifestV1 => {
    if (!isRecord(raw)) validationFailure('INVALID_MANIFEST', '$', 'Expected a migration manifest object');
    requireExactKeys(
        raw,
        ['schema_version', 'package_id', 'migrations'],
        ['schema_version', 'package_id', 'migrations'],
        'INVALID_MANIFEST',
        '$',
    );
    if (raw.schema_version !== 1) {
        validationFailure('INVALID_MANIFEST', '$.schema_version', 'Only migration schema version 1 is supported');
    }
    const packageId = requireString(raw.package_id, 'INVALID_MANIFEST', '$.package_id', 128);
    if (!PACKAGE_ID_RE.test(packageId)) {
        validationFailure('INVALID_MANIFEST', '$.package_id', 'Invalid CK package ID');
    }
    if (!Array.isArray(raw.migrations) || raw.migrations.length === 0 || raw.migrations.length > 128) {
        validationFailure('INVALID_MANIFEST', '$.migrations', 'Expected 1 to 128 migration steps');
    }

    const stepIds = new Set<string>();
    const migrations = raw.migrations.map((step, stepIndex): BlockPackageMigrationStep => {
        const path = `$.migrations[${stepIndex}]`;
        if (!isRecord(step)) validationFailure('INVALID_MANIFEST', path, 'Expected a migration step object');
        requireExactKeys(
            step,
            ['id', 'from', 'to', 'operations'],
            ['id', 'from', 'to', 'operations'],
            'INVALID_MANIFEST',
            path,
        );
        const id = requireString(step.id, 'INVALID_MANIFEST', `${path}.id`, 128);
        if (!IDENTIFIER_RE.test(id)) validationFailure('INVALID_MANIFEST', `${path}.id`, 'Invalid migration step ID');
        if (stepIds.has(id)) validationFailure('INVALID_MANIFEST', `${path}.id`, 'Duplicate migration step ID');
        stepIds.add(id);

        const from = requireString(step.from, 'INVALID_MANIFEST', `${path}.from`, 512);
        parseVersionSelector(from, 'INVALID_MANIFEST', `${path}.from`);
        const to = requireString(step.to, 'INVALID_MANIFEST', `${path}.to`, 256);
        parseSemVer(to, 'INVALID_MANIFEST', `${path}.to`);
        if (!Array.isArray(step.operations) || step.operations.length === 0 || step.operations.length > 256) {
            validationFailure('INVALID_MANIFEST', `${path}.operations`, 'Expected 1 to 256 operations');
        }
        const operations = step.operations.map((operation, operationIndex) => (
            parseOperation(operation, `${path}.operations[${operationIndex}]`)
        ));
        return { id, from, to, operations };
    });

    return { schema_version: 1, package_id: packageId, migrations };
};

const cloneJsonValue = (
    value: unknown,
    path: string,
    ancestors: Set<object>,
): MigrationJsonValue => {
    if (
        value === null
        || typeof value === 'string'
        || typeof value === 'boolean'
        || (typeof value === 'number' && Number.isFinite(value))
    ) {
        return value;
    }
    if (Array.isArray(value)) {
        if (ancestors.has(value)) validationFailure('INVALID_WORKSPACE', path, 'Workspace contains a cycle');
        ancestors.add(value);
        const cloned = value.map((entry, index) => cloneJsonValue(entry, `${path}[${index}]`, ancestors));
        ancestors.delete(value);
        return cloned;
    }
    if (isRecord(value)) {
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) {
            validationFailure('INVALID_WORKSPACE', path, 'Workspace must contain plain JSON objects only');
        }
        if (Object.getOwnPropertySymbols(value).length > 0) {
            validationFailure('INVALID_WORKSPACE', path, 'Workspace cannot contain symbol properties');
        }
        if (ancestors.has(value)) validationFailure('INVALID_WORKSPACE', path, 'Workspace contains a cycle');
        ancestors.add(value);
        const cloned: MigrationJsonObject = {};
        for (const key of Object.keys(value)) {
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            if (!descriptor || !hasOwn(descriptor, 'value')) {
                validationFailure('INVALID_WORKSPACE', `${path}.${key}`, 'Workspace cannot contain accessors');
            }
            cloned[key] = cloneJsonValue(descriptor.value, `${path}.${key}`, ancestors);
        }
        ancestors.delete(value);
        return cloned;
    }
    return validationFailure('INVALID_WORKSPACE', path, 'Workspace must contain JSON values only');
};

const cloneWorkspace = (workspace: unknown): MigrationJsonObject => {
    const cloned = cloneJsonValue(workspace, '$', new Set());
    if (!isRecord(cloned)) {
        validationFailure('INVALID_WORKSPACE', '$', 'Blockly workspace state must be a JSON object');
    }
    return cloned as MigrationJsonObject;
};

const isJsonObject = (value: MigrationJsonValue | undefined): value is MigrationJsonObject => (
    Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const jsonPathProperty = (base: string, property: string): string => (
    /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(property)
        ? `${base}.${property}`
        : `${base}[${JSON.stringify(property)}]`
);

interface MutableBlockReference {
    block: MigrationJsonObject;
    path: string;
    originalType: string;
}

const blockId = (reference: MutableBlockReference): string | undefined => (
    typeof reference.block.id === 'string' ? reference.block.id : undefined
);

const malformedStructureIssue = (
    message: string,
    blockPath?: string,
    propertyPath?: string,
): BlockPackageMigrationIssue => ({
    code: 'MALFORMED_WORKSPACE_STRUCTURE',
    message,
    blockPath,
    propertyPath,
});

const collectBlocklyBlocks = (
    workspace: MigrationJsonObject,
    unresolved: BlockPackageMigrationIssue[],
): MutableBlockReference[] => {
    const references: MutableBlockReference[] = [];

    const visitBlock = (value: MigrationJsonValue | undefined, path: string): void => {
        if (!isJsonObject(value)) {
            unresolved.push(malformedStructureIssue('Expected a Blockly block object', path, path));
            return;
        }
        const type = typeof value.type === 'string' ? value.type : '';
        if (!type) {
            unresolved.push(malformedStructureIssue('Blockly block type is missing or invalid', path, `${path}.type`));
        }
        references.push({ block: value, path, originalType: type });

        if (hasOwn(value, 'inputs')) {
            if (!isJsonObject(value.inputs)) {
                unresolved.push(malformedStructureIssue('Blockly inputs must be an object', path, `${path}.inputs`));
            } else {
                for (const [inputName, inputValue] of Object.entries(value.inputs)) {
                    const inputPath = jsonPathProperty(`${path}.inputs`, inputName);
                    if (!isJsonObject(inputValue)) {
                        unresolved.push(malformedStructureIssue('Blockly input connection must be an object', path, inputPath));
                        continue;
                    }
                    if (hasOwn(inputValue, 'block')) {
                        visitBlock(inputValue.block, `${inputPath}.block`);
                    }
                    if (hasOwn(inputValue, 'shadow')) {
                        visitBlock(inputValue.shadow, `${inputPath}.shadow`);
                    }
                }
            }
        }

        if (hasOwn(value, 'next')) {
            if (!isJsonObject(value.next)) {
                unresolved.push(malformedStructureIssue('Blockly next connection must be an object', path, `${path}.next`));
            } else {
                if (hasOwn(value.next, 'block')) {
                    visitBlock(value.next.block, `${path}.next.block`);
                } else if (hasOwn(value.next, 'type')) {
                    visitBlock(value.next, `${path}.next`);
                }
                if (hasOwn(value.next, 'shadow')) {
                    visitBlock(value.next.shadow, `${path}.next.shadow`);
                }
            }
        }
        // extraState and mutation are deliberately opaque and never traversed.
    };

    const blocks = workspace.blocks;
    if (isJsonObject(blocks) && Array.isArray(blocks.blocks)) {
        blocks.blocks.forEach((block, index) => visitBlock(block, `$.blocks.blocks[${index}]`));
    } else if (Array.isArray(blocks)) {
        blocks.forEach((block, index) => visitBlock(block, `$.blocks[${index}]`));
    } else if (hasOwn(workspace, 'block')) {
        visitBlock(workspace.block, '$.block');
    } else if (hasOwn(workspace, 'type')) {
        visitBlock(workspace, '$');
    } else {
        unresolved.push(malformedStructureIssue('No supported Blockly block container was found', '$', '$.blocks'));
    }
    return references;
};

interface VersionGraphEdge {
    step: BlockPackageMigrationStep;
    toKey: string;
}

interface VersionPathResolution {
    steps: readonly BlockPackageMigrationStep[];
    unresolved: readonly BlockPackageMigrationIssue[];
    ambiguous: readonly BlockPackageMigrationIssue[];
}

const resolveVersionPath = (
    manifest: BlockPackageMigrationManifestV1,
    request: BlockPackageMigrationRequest,
): VersionPathResolution => {
    if (request.packageId !== manifest.package_id) {
        return {
            steps: [],
            unresolved: [{
                code: 'PACKAGE_ID_MISMATCH',
                message: `Migration package ${manifest.package_id} cannot migrate project package ${request.packageId}`,
            }],
            ambiguous: [],
        };
    }

    const start = parseSemVer(request.fromVersion, 'INVALID_REQUEST', '$request.fromVersion');
    const target = parseSemVer(request.toVersion, 'INVALID_REQUEST', '$request.toVersion');
    const startKey = semVerKey(start);
    const targetKey = semVerKey(target);
    if (startKey === targetKey) return { steps: [], unresolved: [], ambiguous: [] };

    const selectors = new Map<string, VersionSelector>();
    const destinations = new Map<string, ParsedSemVer>();
    destinations.set(startKey, start);
    destinations.set(targetKey, target);
    for (const step of manifest.migrations) {
        selectors.set(step.id, parseVersionSelector(step.from, 'INVALID_MANIFEST', `$.migrations.${step.id}.from`));
        const destination = parseSemVer(step.to, 'INVALID_MANIFEST', `$.migrations.${step.id}.to`);
        const key = semVerKey(destination);
        if (!destinations.has(key)) destinations.set(key, destination);
    }

    const edges = new Map<string, VersionGraphEdge[]>();
    for (const [key, version] of destinations) {
        if (key === targetKey) {
            edges.set(key, []);
            continue;
        }
        edges.set(key, manifest.migrations
            .filter(step => selectorMatches(selectors.get(step.id) as VersionSelector, version))
            .map(step => ({
                step,
                toKey: semVerKey(parseSemVer(step.to, 'INVALID_MANIFEST', `$.migrations.${step.id}.to`)),
            })));
    }

    const colors = new Map<string, 'visiting' | 'visited'>();
    const nodeStack: string[] = [];
    const edgeStack: BlockPackageMigrationStep[] = [];
    let cycle: readonly BlockPackageMigrationStep[] | null = null;
    const detectCycle = (key: string): void => {
        if (cycle || key === targetKey) return;
        colors.set(key, 'visiting');
        nodeStack.push(key);
        for (const edge of edges.get(key) || []) {
            if (cycle) break;
            if (colors.get(edge.toKey) === 'visiting') {
                const cycleStart = nodeStack.lastIndexOf(edge.toKey);
                cycle = [...edgeStack.slice(Math.max(0, cycleStart)), edge.step];
                break;
            }
            if (colors.get(edge.toKey) !== 'visited') {
                edgeStack.push(edge.step);
                detectCycle(edge.toKey);
                edgeStack.pop();
            }
        }
        nodeStack.pop();
        colors.set(key, 'visited');
    };
    detectCycle(startKey);
    const detectedCycle = cycle as readonly BlockPackageMigrationStep[] | null;
    if (detectedCycle) {
        return {
            steps: [],
            unresolved: [],
            ambiguous: [{
                code: 'VERSION_PATH_CYCLE',
                message: `Reachable migration cycle: ${detectedCycle.map(step => step.id).join(' -> ')}`,
            }],
        };
    }

    const pathCounts = new Map<string, number>();
    const countPaths = (key: string): number => {
        if (key === targetKey) return 1;
        const cached = pathCounts.get(key);
        if (cached !== undefined) return cached;
        let count = 0;
        for (const edge of edges.get(key) || []) {
            count = Math.min(2, count + countPaths(edge.toKey));
            if (count === 2) break;
        }
        pathCounts.set(key, count);
        return count;
    };

    const count = countPaths(startKey);
    if (count === 0) {
        return {
            steps: [],
            unresolved: [{
                code: 'NO_VERSION_PATH',
                message: `No migration path exists from ${request.fromVersion} to ${request.toVersion}`,
            }],
            ambiguous: [],
        };
    }
    if (count > 1) {
        return {
            steps: [],
            unresolved: [],
            ambiguous: [{
                code: 'MULTIPLE_VERSION_PATHS',
                message: `More than one migration path exists from ${request.fromVersion} to ${request.toVersion}`,
            }],
        };
    }

    const path: BlockPackageMigrationStep[] = [];
    let cursor = startKey;
    while (cursor !== targetKey) {
        const edge = (edges.get(cursor) || []).find(candidate => countPaths(candidate.toKey) === 1);
        if (!edge) {
            return {
                steps: [],
                unresolved: [{ code: 'NO_VERSION_PATH', message: 'Unique migration path resolution failed closed' }],
                ambiguous: [],
            };
        }
        path.push(edge.step);
        cursor = edge.toKey;
    }
    return { steps: path, unresolved: [], ambiguous: [] };
};

interface MutableChangedBlock {
    reference: MutableBlockReference;
    changes: BlockPackageMigrationChange[];
}

const potentialMatches = (
    operation: BlockPackageMigrationOperation,
    references: readonly MutableBlockReference[],
): number => {
    if (operation.op === 'renameBlockType') {
        return references.filter(reference => reference.block.type === operation.from).length;
    }
    return references.filter(reference => {
        if (reference.block.type !== operation.block_type) return false;
        const fields = reference.block.fields;
        if (!isJsonObject(fields)) return false;
        return operation.op === 'renameField'
            ? hasOwn(fields, operation.from)
            : hasOwn(fields, operation.field);
    }).length;
};

const findOperationConflicts = (
    step: BlockPackageMigrationStep,
): { disabled: ReadonlySet<number>; issues: readonly BlockPackageMigrationIssue[] } => {
    const groups = new Map<string, number[]>();
    const add = (key: string, index: number): void => {
        const indexes = groups.get(key) || [];
        if (!indexes.includes(index)) indexes.push(index);
        groups.set(key, indexes);
    };

    step.operations.forEach((operation, index) => {
        if (operation.op === 'renameBlockType') {
            add(JSON.stringify(['type', operation.from]), index);
        } else if (operation.op === 'renameField') {
            add(JSON.stringify(['field', operation.block_type, operation.from]), index);
        } else {
            for (const mapping of operation.mappings) {
                add(JSON.stringify([
                    'enum',
                    operation.block_type,
                    operation.field,
                    scalarKey(mapping.from),
                ]), index);
            }
        }
    });

    const disabled = new Set<number>();
    const issues: BlockPackageMigrationIssue[] = [];
    for (const indexes of groups.values()) {
        if (indexes.length < 2) continue;
        indexes.forEach(index => disabled.add(index));
        issues.push({
            code: 'CONFLICTING_OPERATIONS',
            message: `Migration step ${step.id} contains overlapping deterministic operations`,
            stepId: step.id,
            relatedOperationIndexes: [...indexes],
        });
    }
    return { disabled, issues };
};

const createChange = (
    step: BlockPackageMigrationStep,
    operationIndex: number,
    operation: BlockPackageMigrationOperation,
    reference: MutableBlockReference,
    fromPath: string,
    toPath: string,
    before: MigrationJsonPrimitive,
    after: MigrationJsonPrimitive,
): BlockPackageMigrationChange => ({
    stepId: step.id,
    operationIndex,
    operation: operation.op,
    blockPath: reference.path,
    blockId: blockId(reference),
    fromPath,
    toPath,
    before,
    after,
});

const issueForReference = (
    issue: Omit<BlockPackageMigrationIssue, 'blockPath' | 'blockId'>,
    reference: MutableBlockReference,
): BlockPackageMigrationIssue => ({
    ...issue,
    blockPath: reference.path,
    blockId: blockId(reference),
});

/**
 * Produces a deterministic dry-run. The input workspace and manifest are never
 * mutated; extraState and mutation remain opaque cloned data.
 */
export const planBlockPackageMigration = (
    workspace: unknown,
    rawManifest: unknown,
    request: BlockPackageMigrationRequest,
): BlockPackageMigrationPlan => {
    const manifest = parseBlockPackageMigrationManifest(rawManifest);
    if (!isRecord(request)) validationFailure('INVALID_REQUEST', '$request', 'Expected a migration request object');
    requireExactKeys(
        request as unknown as Record<string, unknown>,
        ['packageId', 'fromVersion', 'toVersion'],
        ['packageId', 'fromVersion', 'toVersion'],
        'INVALID_REQUEST',
        '$request',
    );
    const packageId = requireString(request.packageId, 'INVALID_REQUEST', '$request.packageId', 128);
    const fromVersion = requireString(request.fromVersion, 'INVALID_REQUEST', '$request.fromVersion', 256);
    const toVersion = requireString(request.toVersion, 'INVALID_REQUEST', '$request.toVersion', 256);
    parseSemVer(fromVersion, 'INVALID_REQUEST', '$request.fromVersion');
    parseSemVer(toVersion, 'INVALID_REQUEST', '$request.toVersion');

    const outputWorkspace = cloneWorkspace(workspace);
    const resolution = resolveVersionPath(manifest, { packageId, fromVersion, toVersion });
    const unresolved: BlockPackageMigrationIssue[] = [...resolution.unresolved];
    const ambiguous: BlockPackageMigrationIssue[] = [...resolution.ambiguous];
    const operationDetails: MigrationOperationDetail[] = [];
    const changedByPath = new Map<string, MutableChangedBlock>();

    const finish = (path: readonly BlockPackageMigrationStep[]): BlockPackageMigrationPlan => {
        const changedBlocks = Array.from(changedByPath.values(), entry => ({
            path: entry.reference.path,
            id: blockId(entry.reference),
            originalType: entry.reference.originalType,
            migratedType: typeof entry.reference.block.type === 'string'
                ? entry.reference.block.type
                : entry.reference.originalType,
            changes: entry.changes,
        }));
        const canApply = unresolved.length === 0 && ambiguous.length === 0;
        return {
            status: canApply ? 'ready' : 'blocked',
            canApply,
            packageId,
            fromVersion,
            toVersion,
            path: path.map(step => ({
                id: step.id,
                from: step.from,
                to: step.to,
                operationCount: step.operations.length,
            })),
            changedBlockCount: changedBlocks.length,
            changedBlocks,
            operationDetails,
            unresolved,
            ambiguous,
            outputWorkspace,
        };
    };

    if (unresolved.length > 0 || ambiguous.length > 0) return finish([]);
    const references = collectBlocklyBlocks(outputWorkspace, unresolved);

    const recordChange = (
        reference: MutableBlockReference,
        change: BlockPackageMigrationChange,
    ): void => {
        const entry = changedByPath.get(reference.path) || { reference, changes: [] };
        entry.changes.push(change);
        changedByPath.set(reference.path, entry);
    };

    for (const step of resolution.steps) {
        const conflicts = findOperationConflicts(step);
        ambiguous.push(...conflicts.issues);

        step.operations.forEach((operation, operationIndex) => {
            const detailChanges: BlockPackageMigrationChange[] = [];
            const unresolvedBefore = unresolved.length;
            const ambiguousBefore = ambiguous.length;
            let matchedBlockCount = 0;

            if (conflicts.disabled.has(operationIndex)) {
                matchedBlockCount = potentialMatches(operation, references);
            } else if (operation.op === 'renameBlockType') {
                for (const reference of references) {
                    if (reference.block.type !== operation.from) continue;
                    matchedBlockCount += 1;
                    reference.block.type = operation.to;
                    const change = createChange(
                        step,
                        operationIndex,
                        operation,
                        reference,
                        `${reference.path}.type`,
                        `${reference.path}.type`,
                        operation.from,
                        operation.to,
                    );
                    detailChanges.push(change);
                    recordChange(reference, change);
                }
            } else if (operation.op === 'renameField') {
                for (const reference of references) {
                    if (reference.block.type !== operation.block_type) continue;
                    const fields = reference.block.fields;
                    if (fields !== undefined && !isJsonObject(fields)) {
                        unresolved.push(issueForReference({
                            code: 'FIELD_CONTAINER_INVALID',
                            message: `Fields for ${operation.block_type} must be an object`,
                            stepId: step.id,
                            operationIndex,
                            propertyPath: `${reference.path}.fields`,
                        }, reference));
                        continue;
                    }
                    if (!isJsonObject(fields) || !hasOwn(fields, operation.from)) continue;
                    matchedBlockCount += 1;
                    if (hasOwn(fields, operation.to)) {
                        ambiguous.push(issueForReference({
                            code: 'FIELD_NAME_COLLISION',
                            message: `Both ${operation.from} and ${operation.to} exist; neither value was deleted`,
                            stepId: step.id,
                            operationIndex,
                            propertyPath: `${reference.path}.fields`,
                        }, reference));
                        continue;
                    }
                    fields[operation.to] = fields[operation.from];
                    delete fields[operation.from];
                    const fromPath = jsonPathProperty(`${reference.path}.fields`, operation.from);
                    const toPath = jsonPathProperty(`${reference.path}.fields`, operation.to);
                    const change = createChange(
                        step,
                        operationIndex,
                        operation,
                        reference,
                        fromPath,
                        toPath,
                        operation.from,
                        operation.to,
                    );
                    detailChanges.push(change);
                    recordChange(reference, change);
                }
            } else {
                for (const reference of references) {
                    if (reference.block.type !== operation.block_type) continue;
                    const fields = reference.block.fields;
                    if (fields !== undefined && !isJsonObject(fields)) {
                        unresolved.push(issueForReference({
                            code: 'FIELD_CONTAINER_INVALID',
                            message: `Fields for ${operation.block_type} must be an object`,
                            stepId: step.id,
                            operationIndex,
                            propertyPath: `${reference.path}.fields`,
                        }, reference));
                        continue;
                    }
                    if (!isJsonObject(fields) || !hasOwn(fields, operation.field)) continue;
                    matchedBlockCount += 1;
                    const rawValue = fields[operation.field];
                    if (
                        rawValue !== null
                        && typeof rawValue !== 'string'
                        && typeof rawValue !== 'boolean'
                        && typeof rawValue !== 'number'
                    ) {
                        unresolved.push(issueForReference({
                            code: 'ENUM_VALUE_INVALID',
                            message: `Enum field ${operation.field} is not a JSON scalar`,
                            stepId: step.id,
                            operationIndex,
                            propertyPath: jsonPathProperty(`${reference.path}.fields`, operation.field),
                            value: rawValue,
                        }, reference));
                        continue;
                    }
                    const value = rawValue as MigrationJsonPrimitive;
                    const mapping = operation.mappings.find(entry => scalarEquals(entry.from, value));
                    if (!mapping) {
                        unresolved.push(issueForReference({
                            code: 'ENUM_VALUE_UNMAPPED',
                            message: `Enum field ${operation.field} value is not covered by the migration`,
                            stepId: step.id,
                            operationIndex,
                            propertyPath: jsonPathProperty(`${reference.path}.fields`, operation.field),
                            value,
                        }, reference));
                        continue;
                    }
                    if (scalarEquals(value, mapping.to)) continue;
                    fields[operation.field] = mapping.to;
                    const propertyPath = jsonPathProperty(`${reference.path}.fields`, operation.field);
                    const change = createChange(
                        step,
                        operationIndex,
                        operation,
                        reference,
                        propertyPath,
                        propertyPath,
                        value,
                        mapping.to,
                    );
                    detailChanges.push(change);
                    recordChange(reference, change);
                }
            }

            const unresolvedCount = unresolved.length - unresolvedBefore;
            const ambiguousCount = ambiguous.length - ambiguousBefore
                + (conflicts.disabled.has(operationIndex) ? 1 : 0);
            operationDetails.push({
                stepId: step.id,
                operationIndex,
                operation,
                status: unresolvedCount > 0 || ambiguousCount > 0
                    ? 'blocked'
                    : detailChanges.length > 0 ? 'applied' : 'no-match',
                matchedBlockCount,
                changedBlockCount: new Set(detailChanges.map(change => change.blockPath)).size,
                unresolvedCount,
                ambiguousCount,
                changes: detailChanges,
            });
        });
    }

    return finish(resolution.steps);
};

/** Applies only a fully resolved plan; blocked previews are never returned as an application. */
export const applyBlockPackageMigration = (
    workspace: unknown,
    rawManifest: unknown,
    request: BlockPackageMigrationRequest,
): BlockPackageMigrationApplication => {
    const plan = planBlockPackageMigration(workspace, rawManifest, request);
    if (!plan.canApply) throw new BlockPackageMigrationBlockedError(plan);
    return { workspace: plan.outputWorkspace, plan };
};
