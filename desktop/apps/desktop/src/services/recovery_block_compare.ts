export type RecoveryBlockChangeKind = 'same' | 'added' | 'removed' | 'changed';

export interface RecoveryBlockComparison {
    currentKinds: Readonly<Record<string, RecoveryBlockChangeKind>>;
    draftKinds: Readonly<Record<string, RecoveryBlockChangeKind>>;
    currentBlockCount: number;
    draftBlockCount: number;
    addedCount: number;
    removedCount: number;
    changedCount: number;
    unchangedCount: number;
    parseError: string | null;
}

export interface RecoveryPreviewWorkspace {
    state: Record<string, unknown> | null;
    blockCount: number;
    unknownBlockCount: number;
    unknownTypeNames: readonly string[];
    parseError: string | null;
}

interface SerializedBlockIdentity {
    id: string;
    type: string;
    signature: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
    Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const stableValue = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stableValue);
    if (!isRecord(value)) return value;
    return Object.fromEntries(
        Object.entries(value)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, item]) => [key, stableValue(item)]),
    );
};

const parseWorkspace = (raw: string): Record<string, unknown> => {
    const parseable = String(raw || '').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(parseable) as unknown;
    if (!isRecord(parsed)) throw new Error('积木工作区不是有效的 JSON 对象');
    return parsed;
};

const connectedBlockRef = (value: unknown, key: 'block' | 'shadow'): Record<string, unknown> | null => {
    if (!isRecord(value)) return null;
    return isRecord(value[key]) ? value[key] as Record<string, unknown> : null;
};

const blockSignature = (block: Record<string, unknown>): string => {
    const inputs = isRecord(block.inputs) ? block.inputs : {};
    const inputConnections = Object.fromEntries(Object.entries(inputs).map(([name, input]) => {
        const child = connectedBlockRef(input, 'block') || connectedBlockRef(input, 'shadow');
        return [name, child ? {
            id: typeof child.id === 'string' ? child.id : '',
            type: typeof child.type === 'string' ? child.type : '',
        } : null];
    }));
    const next = connectedBlockRef(block.next, 'block');
    const shallow = Object.fromEntries(
        Object.entries(block).filter(([key]) => !['id', 'x', 'y', 'inputs', 'next'].includes(key)),
    );
    return JSON.stringify(stableValue({
        ...shallow,
        inputConnections,
        next: next ? {
            id: typeof next.id === 'string' ? next.id : '',
            type: typeof next.type === 'string' ? next.type : '',
        } : null,
    }));
};

const collectSerializedBlocks = (raw: string): SerializedBlockIdentity[] => {
    const state = parseWorkspace(raw);
    const blocksRoot = isRecord(state.blocks) ? state.blocks : null;
    const roots = Array.isArray(blocksRoot?.blocks) ? blocksRoot.blocks : [];
    const result: SerializedBlockIdentity[] = [];

    const visit = (value: unknown, path: string) => {
        if (!isRecord(value) || typeof value.type !== 'string') return;
        const id = typeof value.id === 'string' && value.id.trim() ? value.id : `@${path}`;
        result.push({ id, type: value.type, signature: blockSignature(value) });
        const inputs = isRecord(value.inputs) ? value.inputs : {};
        Object.entries(inputs).forEach(([name, input]) => {
            const block = connectedBlockRef(input, 'block');
            const shadow = connectedBlockRef(input, 'shadow');
            if (block) visit(block, `${path}/inputs/${name}/block`);
            if (shadow && shadow !== block) visit(shadow, `${path}/inputs/${name}/shadow`);
        });
        const next = connectedBlockRef(value.next, 'block');
        if (next) visit(next, `${path}/next/block`);
    };

    roots.forEach((block, index) => visit(block, `blocks/${index}`));
    return result;
};

export const createRecoveryBlockComparison = (
    currentWorkspaceJson: string,
    draftWorkspaceJson: string,
): RecoveryBlockComparison => {
    try {
        const current = collectSerializedBlocks(currentWorkspaceJson);
        const draft = collectSerializedBlocks(draftWorkspaceJson);
        const currentById = new Map(current.map(block => [block.id, block]));
        const draftById = new Map(draft.map(block => [block.id, block]));
        const currentKinds: Record<string, RecoveryBlockChangeKind> = {};
        const draftKinds: Record<string, RecoveryBlockChangeKind> = {};
        let addedCount = 0;
        let removedCount = 0;
        let changedCount = 0;
        let unchangedCount = 0;

        current.forEach((block) => {
            const other = draftById.get(block.id);
            if (!other) {
                currentKinds[block.id] = 'removed';
                removedCount += 1;
            } else if (other.type !== block.type || other.signature !== block.signature) {
                currentKinds[block.id] = 'changed';
                draftKinds[block.id] = 'changed';
                changedCount += 1;
            } else {
                currentKinds[block.id] = 'same';
                draftKinds[block.id] = 'same';
                unchangedCount += 1;
            }
        });

        draft.forEach((block) => {
            if (currentById.has(block.id)) return;
            draftKinds[block.id] = 'added';
            addedCount += 1;
        });

        return {
            currentKinds,
            draftKinds,
            currentBlockCount: current.length,
            draftBlockCount: draft.length,
            addedCount,
            removedCount,
            changedCount,
            unchangedCount,
            parseError: null,
        };
    } catch (error) {
        return {
            currentKinds: {},
            draftKinds: {},
            currentBlockCount: 0,
            draftBlockCount: 0,
            addedCount: 0,
            removedCount: 0,
            changedCount: 0,
            unchangedCount: 0,
            parseError: error instanceof Error ? error.message : String(error),
        };
    }
};

/**
 * Makes an isolated preview copy. Unknown third-party blocks are omitted only
 * from this disposable preview; the exact recovery payload is never changed.
 * A known block after an unknown statement is promoted so the rest of the
 * visible chain remains understandable.
 */
export const createRecoveryPreviewWorkspace = (
    workspaceJson: string,
    isKnownBlockType: (type: string) => boolean,
): RecoveryPreviewWorkspace => {
    try {
        const state = parseWorkspace(workspaceJson);
        const unknownTypes = new Map<string, number>();
        let blockCount = 0;

        const sanitizeBlock = (value: unknown): Record<string, unknown> | null => {
            if (!isRecord(value) || typeof value.type !== 'string') return null;
            const type = value.type;
            if (!isKnownBlockType(type)) {
                unknownTypes.set(type, (unknownTypes.get(type) || 0) + 1);
                return sanitizeBlock(connectedBlockRef(value.next, 'block'));
            }

            blockCount += 1;
            const result: Record<string, unknown> = { ...value };
            if (isRecord(value.inputs)) {
                const inputs: Record<string, unknown> = {};
                Object.entries(value.inputs).forEach(([name, inputValue]) => {
                    if (!isRecord(inputValue)) return;
                    const input: Record<string, unknown> = { ...inputValue };
                    const block = sanitizeBlock(connectedBlockRef(inputValue, 'block'));
                    const shadow = sanitizeBlock(connectedBlockRef(inputValue, 'shadow'));
                    if (block) input.block = block;
                    else delete input.block;
                    if (shadow) input.shadow = shadow;
                    else delete input.shadow;
                    if (input.block || input.shadow) inputs[name] = input;
                });
                result.inputs = inputs;
            }
            const next = sanitizeBlock(connectedBlockRef(value.next, 'block'));
            if (next) result.next = { ...(isRecord(value.next) ? value.next : {}), block: next };
            else delete result.next;
            return result;
        };

        const blocksRoot = isRecord(state.blocks) ? state.blocks : {};
        const roots = Array.isArray(blocksRoot.blocks) ? blocksRoot.blocks : [];
        const sanitizedRoots = roots
            .map(block => sanitizeBlock(block))
            .filter((block): block is Record<string, unknown> => Boolean(block));
        const sanitizedState: Record<string, unknown> = {
            ...state,
            blocks: { ...blocksRoot, blocks: sanitizedRoots },
        };
        const unknownTypeNames = Array.from(unknownTypes.keys()).sort((left, right) => left.localeCompare(right));
        return {
            state: sanitizedState,
            blockCount,
            unknownBlockCount: Array.from(unknownTypes.values()).reduce((sum, count) => sum + count, 0),
            unknownTypeNames,
            parseError: null,
        };
    } catch (error) {
        return {
            state: null,
            blockCount: 0,
            unknownBlockCount: 0,
            unknownTypeNames: [],
            parseError: error instanceof Error ? error.message : String(error),
        };
    }
};
