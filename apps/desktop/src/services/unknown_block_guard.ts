export type WorkspaceSerializationFormat = 'json' | 'xml';

export type WorkspaceLoadDecision = 'normal' | 'read-only-protection';

export type UnknownBlockSource =
    | 'root'
    | 'input'
    | 'next'
    | 'shadow'
    | 'extraState'
    | 'mutation';

export type UnknownBlockNodeKind = 'block' | 'shadow';

export type KnownBlockTypeLookup =
    | ReadonlySet<string>
    | ReadonlyMap<string, unknown>
    | Readonly<Record<string, unknown>>
    | ((type: string) => boolean);

export interface UnknownBlockOccurrence {
    type: string;
    path: string;
    source: UnknownBlockSource;
    nodeKind: UnknownBlockNodeKind;
}

export interface UnknownBlockTypeSummary {
    type: string;
    count: number;
    paths: readonly string[];
    sources: readonly UnknownBlockSource[];
}

export interface RawWorkspaceSnapshot {
    format: WorkspaceSerializationFormat;
    /** Exact input text for serialized inputs; canonical JSON for object inputs. */
    serialized: string;
    sha256: string;
    utf8ByteLength: number;
}

export interface WorkspaceLoadInspection {
    format: WorkspaceSerializationFormat;
    loadDecision: WorkspaceLoadDecision;
    /** False means callers must not pass this workspace to Blockly deserialization. */
    canDeserializeIntoBlockly: boolean;
    /** False means normal save must not overwrite the source project. */
    canOverwriteSource: boolean;
    unknownBlockCount: number;
    unknownTypeNames: readonly string[];
    unknownTypes: readonly UnknownBlockTypeSummary[];
    occurrences: readonly UnknownBlockOccurrence[];
    rawWorkspace: RawWorkspaceSnapshot;
}

interface XmlElementLike {
    nodeType?: number;
    localName?: string | null;
    tagName?: string;
    nodeName?: string;
    /** Kept unknown so native DOM collections are structurally compatible. */
    children?: ArrayLike<unknown>;
    childNodes?: ArrayLike<unknown>;
    getAttribute(name: string): string | null;
}

interface XmlDocumentLike {
    nodeType?: number;
    documentElement?: XmlElementLike | null;
}

export interface WorkspaceInspectionOptions {
    format?: WorkspaceSerializationFormat | 'auto';
    /**
     * Useful for non-browser tests or hosts. The parser must only parse XML and
     * return a Document/Element; the guard never evaluates scripts or mutates it.
     */
    parseXml?: (serialized: string) => XmlDocumentLike | XmlElementLike;
}

const SHA256_CONSTANTS = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
    0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
    0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
    0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
    0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
    0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotateRight = (value: number, bits: number): number => (
    (value >>> bits) | (value << (32 - bits))
) >>> 0;

const encodeUtf8 = (value: string): Uint8Array => new TextEncoder().encode(value);

/** Synchronous SHA-256 keeps the pre-load decision atomic in browser and Node hosts. */
export const sha256WorkspaceText = (value: string): string => {
    const input = encodeUtf8(value);
    const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
    const message = new Uint8Array(paddedLength);
    message.set(input);
    message[input.length] = 0x80;

    const bitLength = input.length * 8;
    const view = new DataView(message.buffer);
    view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000), false);
    view.setUint32(paddedLength - 4, bitLength >>> 0, false);

    const hash = new Uint32Array([
        0x6a09e667,
        0xbb67ae85,
        0x3c6ef372,
        0xa54ff53a,
        0x510e527f,
        0x9b05688c,
        0x1f83d9ab,
        0x5be0cd19,
    ]);
    const words = new Uint32Array(64);

    for (let offset = 0; offset < paddedLength; offset += 64) {
        for (let index = 0; index < 16; index += 1) {
            words[index] = view.getUint32(offset + (index * 4), false);
        }
        for (let index = 16; index < 64; index += 1) {
            const left = words[index - 15];
            const right = words[index - 2];
            const sigma0 = rotateRight(left, 7) ^ rotateRight(left, 18) ^ (left >>> 3);
            const sigma1 = rotateRight(right, 17) ^ rotateRight(right, 19) ^ (right >>> 10);
            words[index] = (
                words[index - 16]
                + sigma0
                + words[index - 7]
                + sigma1
            ) >>> 0;
        }

        let a = hash[0];
        let b = hash[1];
        let c = hash[2];
        let d = hash[3];
        let e = hash[4];
        let f = hash[5];
        let g = hash[6];
        let h = hash[7];

        for (let index = 0; index < 64; index += 1) {
            const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
            const choice = (e & f) ^ ((~e) & g);
            const temporary1 = (h + sum1 + choice + SHA256_CONSTANTS[index] + words[index]) >>> 0;
            const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
            const majority = (a & b) ^ (a & c) ^ (b & c);
            const temporary2 = (sum0 + majority) >>> 0;

            h = g;
            g = f;
            f = e;
            e = (d + temporary1) >>> 0;
            d = c;
            c = b;
            b = a;
            a = (temporary1 + temporary2) >>> 0;
        }

        hash[0] = (hash[0] + a) >>> 0;
        hash[1] = (hash[1] + b) >>> 0;
        hash[2] = (hash[2] + c) >>> 0;
        hash[3] = (hash[3] + d) >>> 0;
        hash[4] = (hash[4] + e) >>> 0;
        hash[5] = (hash[5] + f) >>> 0;
        hash[6] = (hash[6] + g) >>> 0;
        hash[7] = (hash[7] + h) >>> 0;
    }

    return Array.from(hash, word => word.toString(16).padStart(8, '0')).join('');
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
    Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const createKnownTypePredicate = (lookup: KnownBlockTypeLookup): ((type: string) => boolean) => {
    if (typeof lookup === 'function') {
        return (type: string) => {
            try {
                return type.length > 0 && lookup(type) === true;
            } catch {
                return false;
            }
        };
    }

    const lookupWithHas = lookup as { has?: (type: string) => boolean };
    if (typeof lookupWithHas.has === 'function') {
        return (type: string) => {
            try {
                return type.length > 0 && lookupWithHas.has?.call(lookup, type) === true;
            } catch {
                return false;
            }
        };
    }

    return (type: string) => type.length > 0 && Object.prototype.hasOwnProperty.call(lookup, type);
};

const jsonPathProperty = (base: string, property: string): string => (
    /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(property)
        ? `${base}.${property}`
        : `${base}[${JSON.stringify(property)}]`
);

const canonicalizeJson = (value: unknown, ancestors: Set<object>): unknown => {
    if (Array.isArray(value)) {
        if (ancestors.has(value)) throw new TypeError('Blockly JSON workspace contains a cycle');
        ancestors.add(value);
        const result = value.map(entry => canonicalizeJson(entry, ancestors));
        ancestors.delete(value);
        return result;
    }
    if (isRecord(value)) {
        if (ancestors.has(value)) throw new TypeError('Blockly JSON workspace contains a cycle');
        ancestors.add(value);
        const result: Record<string, unknown> = {};
        for (const key of Object.keys(value).sort()) {
            const entry = canonicalizeJson(value[key], ancestors);
            if (entry !== undefined) result[key] = entry;
        }
        ancestors.delete(value);
        return result;
    }
    if (typeof value === 'bigint') {
        throw new TypeError('Blockly JSON workspace cannot contain bigint values');
    }
    return value;
};

export const stableSerializeJsonWorkspace = (value: unknown): string => {
    const serialized = JSON.stringify(canonicalizeJson(value, new Set()));
    if (serialized === undefined) {
        throw new TypeError('Blockly JSON workspace must be a JSON object or array');
    }
    return serialized;
};

const freezeOccurrence = (occurrence: UnknownBlockOccurrence): UnknownBlockOccurrence => (
    Object.freeze({ ...occurrence })
);

const buildInspection = (
    format: WorkspaceSerializationFormat,
    serialized: string,
    mutableOccurrences: UnknownBlockOccurrence[],
): WorkspaceLoadInspection => {
    const occurrences = Object.freeze(mutableOccurrences.map(freezeOccurrence));
    const summaries = new Map<string, {
        count: number;
        paths: string[];
        sources: Set<UnknownBlockSource>;
    }>();

    for (const occurrence of occurrences) {
        const summary = summaries.get(occurrence.type) || {
            count: 0,
            paths: [],
            sources: new Set<UnknownBlockSource>(),
        };
        summary.count += 1;
        summary.paths.push(occurrence.path);
        summary.sources.add(occurrence.source);
        summaries.set(occurrence.type, summary);
    }

    const unknownTypes = Object.freeze(Array.from(summaries, ([type, summary]) => Object.freeze({
        type,
        count: summary.count,
        paths: Object.freeze([...summary.paths]),
        sources: Object.freeze(Array.from(summary.sources)),
    })));
    const unknownTypeNames = Object.freeze(unknownTypes.map(summary => summary.type));
    const protectedMode = occurrences.length > 0;
    const encoded = encodeUtf8(serialized);
    const rawWorkspace = Object.freeze({
        format,
        serialized,
        sha256: sha256WorkspaceText(serialized),
        utf8ByteLength: encoded.length,
    });

    return Object.freeze({
        format,
        loadDecision: protectedMode ? 'read-only-protection' : 'normal',
        canDeserializeIntoBlockly: !protectedMode,
        canOverwriteSource: !protectedMode,
        unknownBlockCount: occurrences.length,
        unknownTypeNames,
        unknownTypes,
        occurrences,
        rawWorkspace,
    });
};

const scanJsonWorkspace = (
    state: unknown,
    isKnownType: (type: string) => boolean,
): UnknownBlockOccurrence[] => {
    const occurrences: UnknownBlockOccurrence[] = [];

    const inspectType = (
        block: Record<string, unknown>,
        path: string,
        source: UnknownBlockSource,
        nodeKind: UnknownBlockNodeKind,
    ) => {
        const type = typeof block.type === 'string' ? block.type : '';
        if (!isKnownType(type)) occurrences.push({ type, path, source, nodeKind });
    };

    const scanEmbeddedContainer = (
        value: unknown,
        path: string,
        source: 'extraState' | 'mutation',
        hintedKind: UnknownBlockNodeKind = 'block',
    ): void => {
        if (Array.isArray(value)) {
            value.forEach((entry, index) => {
                scanEmbeddedContainer(entry, `${path}[${index}]`, source, hintedKind);
            });
            return;
        }
        if (!isRecord(value)) return;

        // Raw mutator state has no universal schema. Fail closed when it carries
        // a type-bearing node, then continue through standard block connections.
        if (Object.prototype.hasOwnProperty.call(value, 'type')) {
            scanBlock(value, path, source, hintedKind, true);
            return;
        }

        for (const [key, entry] of Object.entries(value)) {
            const kind = key.toLowerCase() === 'shadow' ? 'shadow' : 'block';
            scanEmbeddedContainer(entry, jsonPathProperty(path, key), source, kind);
        }
    };

    const scanBlock = (
        value: unknown,
        path: string,
        source: UnknownBlockSource,
        nodeKind: UnknownBlockNodeKind,
        scanAdditionalRawChildren = false,
    ): void => {
        if (!isRecord(value)) return;
        inspectType(value, path, source, nodeKind);
        const rawContainerSource = source === 'extraState' || source === 'mutation'
            ? source
            : null;

        if (isRecord(value.inputs)) {
            for (const [inputName, inputValue] of Object.entries(value.inputs)) {
                if (!isRecord(inputValue)) continue;
                const inputPath = jsonPathProperty(jsonPathProperty(path, 'inputs'), inputName);
                if (Object.prototype.hasOwnProperty.call(inputValue, 'block')) {
                    scanBlock(
                        inputValue.block,
                        jsonPathProperty(inputPath, 'block'),
                        rawContainerSource || 'input',
                        'block',
                    );
                }
                if (Object.prototype.hasOwnProperty.call(inputValue, 'shadow')) {
                    scanBlock(
                        inputValue.shadow,
                        jsonPathProperty(inputPath, 'shadow'),
                        rawContainerSource || 'shadow',
                        'shadow',
                    );
                }
            }
        }

        if (isRecord(value.next)) {
            if (Object.prototype.hasOwnProperty.call(value.next, 'block')) {
                scanBlock(
                    value.next.block,
                    jsonPathProperty(jsonPathProperty(path, 'next'), 'block'),
                    rawContainerSource || 'next',
                    'block',
                );
            } else if (Object.prototype.hasOwnProperty.call(value.next, 'type')) {
                scanBlock(value.next, jsonPathProperty(path, 'next'), rawContainerSource || 'next', 'block');
            }
            if (Object.prototype.hasOwnProperty.call(value.next, 'shadow')) {
                scanBlock(
                    value.next.shadow,
                    jsonPathProperty(jsonPathProperty(path, 'next'), 'shadow'),
                    rawContainerSource || 'shadow',
                    'shadow',
                );
            }
        }

        if (Object.prototype.hasOwnProperty.call(value, 'extraState')) {
            scanEmbeddedContainer(value.extraState, jsonPathProperty(path, 'extraState'), 'extraState');
        }
        if (Object.prototype.hasOwnProperty.call(value, 'mutation')) {
            scanEmbeddedContainer(value.mutation, jsonPathProperty(path, 'mutation'), 'mutation');
        }

        if (scanAdditionalRawChildren && rawContainerSource) {
            const handled = new Set([
                'type', 'id', 'x', 'y', 'inputs', 'next', 'extraState', 'mutation',
                'fields', 'icons', 'collapsed', 'enabled', 'deletable', 'movable',
                'editable', 'inline', 'data',
            ]);
            for (const [key, entry] of Object.entries(value)) {
                if (handled.has(key)) continue;
                scanEmbeddedContainer(entry, jsonPathProperty(path, key), rawContainerSource);
            }
        }
    };

    if (isRecord(state) && isRecord(state.blocks) && Array.isArray(state.blocks.blocks)) {
        state.blocks.blocks.forEach((block, index) => {
            scanBlock(block, `$.blocks.blocks[${index}]`, 'root', 'block');
        });
    } else if (isRecord(state) && Array.isArray(state.blocks)) {
        state.blocks.forEach((block, index) => {
            scanBlock(block, `$.blocks[${index}]`, 'root', 'block');
        });
    } else if (isRecord(state) && Object.prototype.hasOwnProperty.call(state, 'block')) {
        scanBlock(state.block, '$.block', 'root', 'block');
    } else if (isRecord(state) && Object.prototype.hasOwnProperty.call(state, 'type')) {
        scanBlock(state, '$', 'root', 'block');
    }

    return occurrences;
};

const xmlElementName = (element: XmlElementLike): string => {
    const rawName = String(element.localName || element.tagName || element.nodeName || 'element');
    const localName = rawName.includes(':') ? rawName.slice(rawName.lastIndexOf(':') + 1) : rawName;
    return localName.toLowerCase();
};

const xmlElementChildren = (node: XmlElementLike): XmlElementLike[] => {
    const children = node.children || node.childNodes;
    if (!children) return [];
    return Array.from(children).filter((child): child is XmlElementLike => (
        isXmlElement(child) && (child.nodeType === undefined || child.nodeType === 1)
    ));
};

const isXmlElement = (value: unknown): value is XmlElementLike => (
    Boolean(value)
    && typeof value === 'object'
    && typeof (value as XmlElementLike).getAttribute === 'function'
);

const defaultParseXml = (serialized: string): XmlDocumentLike => {
    if (typeof DOMParser === 'undefined') {
        throw new Error('XML inspection requires DOMParser or WorkspaceInspectionOptions.parseXml');
    }
    return new DOMParser().parseFromString(serialized, 'application/xml');
};

const findXmlRoot = (parsed: XmlDocumentLike | XmlElementLike): XmlElementLike => {
    if (isXmlElement(parsed)) return parsed;
    if (isXmlElement(parsed.documentElement)) return parsed.documentElement;
    throw new Error('XML parser did not return a document element');
};

const scanXmlWorkspace = (
    serialized: string,
    isKnownType: (type: string) => boolean,
    parseXml: (serialized: string) => XmlDocumentLike | XmlElementLike,
): UnknownBlockOccurrence[] => {
    const root = findXmlRoot(parseXml(serialized));
    const occurrences: UnknownBlockOccurrence[] = [];

    interface XmlScanContext {
        relation?: 'input' | 'next';
        rawContainer?: 'extraState' | 'mutation';
    }

    const visit = (element: XmlElementLike, path: string, inherited: XmlScanContext): void => {
        const tag = xmlElementName(element);
        if (tag === 'parsererror') throw new Error('Blockly XML workspace is malformed');

        let context = inherited;
        if (tag === 'mutation') context = { ...context, rawContainer: 'mutation' };
        if (tag === 'extrastate' || tag === 'extra-state' || tag === 'extra_state') {
            context = { ...context, rawContainer: 'extraState' };
        }
        if (tag === 'value' || tag === 'statement' || tag === 'input') {
            context = { ...context, relation: 'input' };
        }
        if (tag === 'next') context = { ...context, relation: 'next' };

        const nodeKind = tag === 'shadow' ? 'shadow' : tag === 'block' ? 'block' : null;
        if (nodeKind) {
            const source: UnknownBlockSource = context.rawContainer
                || (nodeKind === 'shadow' ? 'shadow' : context.relation || 'root');
            const type = element.getAttribute('type') ?? '';
            if (!isKnownType(type)) occurrences.push({ type, path, source, nodeKind });
            // A relation describes this block's connection to its parent. Its own
            // descendants establish fresh input/next relationships.
            context = { rawContainer: context.rawContainer };
        }

        const childIndexes = new Map<string, number>();
        for (const child of xmlElementChildren(element)) {
            const childTag = xmlElementName(child);
            const childIndex = (childIndexes.get(childTag) || 0) + 1;
            childIndexes.set(childTag, childIndex);
            visit(child, `${path}/${childTag}[${childIndex}]`, context);
        }
    };

    visit(root, `/${xmlElementName(root)}[1]`, {});
    return occurrences;
};

export const inspectBlocklyJsonWorkspace = (
    rawWorkspace: string | unknown,
    knownBlockTypes: KnownBlockTypeLookup,
): WorkspaceLoadInspection => {
    const serialized = typeof rawWorkspace === 'string'
        ? rawWorkspace
        : stableSerializeJsonWorkspace(rawWorkspace);
    // JSON.parse does not accept a leading UTF-8 BOM once a file has been
    // decoded to a string. Parse past it while retaining the exact source text
    // in the recovery snapshot and its identity hash.
    const parseable = serialized.startsWith('\uFEFF') ? serialized.slice(1) : serialized;
    const state = JSON.parse(parseable) as unknown;
    const occurrences = scanJsonWorkspace(state, createKnownTypePredicate(knownBlockTypes));
    return buildInspection('json', serialized, occurrences);
};

export const inspectBlocklyXmlWorkspace = (
    rawWorkspace: string,
    knownBlockTypes: KnownBlockTypeLookup,
    options: Pick<WorkspaceInspectionOptions, 'parseXml'> = {},
): WorkspaceLoadInspection => {
    const parser = options.parseXml || defaultParseXml;
    const occurrences = scanXmlWorkspace(
        rawWorkspace,
        createKnownTypePredicate(knownBlockTypes),
        parser,
    );
    return buildInspection('xml', rawWorkspace, occurrences);
};

export const inspectSerializedBlocklyWorkspace = (
    rawWorkspace: string,
    knownBlockTypes: KnownBlockTypeLookup,
    options: WorkspaceInspectionOptions = {},
): WorkspaceLoadInspection => {
    const requestedFormat = options.format || 'auto';
    const leading = rawWorkspace.replace(/^\uFEFF/, '').trimStart();
    const format = requestedFormat === 'auto'
        ? (leading.startsWith('<') ? 'xml' : 'json')
        : requestedFormat;

    return format === 'xml'
        ? inspectBlocklyXmlWorkspace(rawWorkspace, knownBlockTypes, options)
        : inspectBlocklyJsonWorkspace(rawWorkspace, knownBlockTypes);
};
