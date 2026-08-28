export const CK_GENERATOR_SCHEMA = 'ck-generator' as const;
export const CK_GENERATOR_VERSION = 1 as const;

export type DeclarativeGeneratorKind = 'statement' | 'expression';

export interface DeclarativeGeneratorRuleV1 {
    type: string;
    kind: DeclarativeGeneratorKind;
    template: string;
    order: number;
    includes: Readonly<Record<string, string>>;
    declarations: Readonly<Record<string, string>>;
    setup: Readonly<Record<string, string>>;
}

export interface DeclarativeGeneratorDocumentV1 {
    schema: typeof CK_GENERATOR_SCHEMA;
    version: typeof CK_GENERATOR_VERSION;
    rules: readonly Readonly<DeclarativeGeneratorRuleV1>[];
}

export interface DeclarativeRuntimeEntrypoints {
    blocks?: string | null;
    generator?: string | null;
    toolbox?: string | null;
}

const MAX_DOCUMENT_BYTES = 512 * 1024;
const MAX_RULES = 128;
const MAX_TEMPLATE_LENGTH = 16 * 1024;
const MAX_TOTAL_TEMPLATE_BYTES = 384 * 1024;
const MAX_ARTIFACTS_PER_SECTION = 16;
const MAX_DATA_NODES = 10_000;
const MAX_DATA_DEPTH = 64;
const MAX_DYNAMIC_FRAGMENT_LENGTH = 64 * 1024;
const MAX_RENDERED_TEMPLATE_LENGTH = 64 * 1024;
const MAX_RENDERED_INVOCATION_LENGTH = 128 * 1024;
const SAFE_BLOCK_TYPE = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;
const SAFE_SYMBOL = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const SAFE_ARTIFACT_KEY = /^[A-Za-z0-9_.:-]{1,96}$/;
const TEMPLATE_TOKEN = /\{\{(field|field_json|value|statement):([A-Za-z_][A-Za-z0-9_]*)\}\}/g;
const FORBIDDEN_RESOURCE_SCHEME = /(?:^|[\s"'(=])(?:https?|file|data|blob|ftp|ws|wss|javascript|vbscript):/i;
const PROTOCOL_RELATIVE_RESOURCE = /(?:^|[\s"'(=])\/\//;
const CSS_RESOURCE = /\burl\s*\(/i;
const RESOURCE_KEYS = new Set(['src', 'href', 'xlink:href', 'url']);
const PROTOTYPE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const UTF8_ENCODER = new TextEncoder();
const utf8Bytes = (value: string): number => UTF8_ENCODER.encode(value).length;

const asRecord = (value: unknown): Record<string, unknown> | null => (
    value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
);

const textHasExternalResource = (value: string): boolean => (
    FORBIDDEN_RESOURCE_SCHEME.test(value)
    || PROTOCOL_RELATIVE_RESOURCE.test(value)
    || CSS_RESOURCE.test(value)
);

export const assertDeclarativeDataHasNoExternalResources = (
    value: unknown,
    location = 'declarative data',
): void => {
    let nodes = 0;
    const seen = new WeakSet<object>();
    const visit = (candidate: unknown, path: string, depth: number): void => {
        nodes += 1;
        if (nodes > MAX_DATA_NODES || depth > MAX_DATA_DEPTH) {
            throw new Error(`${location} exceeds the structural safety limit`);
        }
        if (typeof candidate === 'string') {
            if (textHasExternalResource(candidate)) {
                throw new Error(`${path} contains an external or inline resource reference`);
            }
            return;
        }
        if (candidate === null || typeof candidate !== 'object') return;
        if (seen.has(candidate)) throw new Error(`${path} contains a cyclic object`);
        seen.add(candidate);
        if (Array.isArray(candidate)) {
            candidate.forEach((item, index) => visit(item, `${path}[${index}]`, depth + 1));
            return;
        }
        const record = candidate as Record<string, unknown>;
        if (String(record.type || '').trim().toLowerCase() === 'field_image') {
            throw new Error(`${path} uses field_image, which is disabled for third-party declarative data`);
        }
        for (const [key, child] of Object.entries(record)) {
            const normalizedKey = key.trim().toLowerCase();
            if (PROTOTYPE_KEYS.has(normalizedKey)) {
                throw new Error(`${path}.${key} uses a prototype-sensitive key`);
            }
            if (RESOURCE_KEYS.has(normalizedKey) && child !== null && child !== '') {
                throw new Error(`${path}.${key} is a resource-bearing field and is disabled`);
            }
            if (normalizedKey === 'callbackkey' || normalizedKey === 'custom') {
                throw new Error(`${path}.${key} may invoke runtime callbacks and is disabled`);
            }
            visit(child, `${path}.${key}`, depth + 1);
        }
    };
    visit(value, location, 0);
};

const parseBoundedJson = (source: string, label: string): unknown => {
    const text = String(source ?? '').replace(/^\uFEFF/, '');
    if (utf8Bytes(text) > MAX_DOCUMENT_BYTES) {
        throw new Error(`${label} exceeds the 512 KiB limit`);
    }
    try {
        return JSON.parse(text);
    } catch (error) {
        throw new Error(`${label} must be strict JSON: ${String(error)}`);
    }
};

export const parseDeclarativeBlockDocument = (source: string): unknown => {
    const raw = parseBoundedJson(source, 'block definitions');
    assertDeclarativeDataHasNoExternalResources(raw, 'block definitions');
    const root = asRecord(raw);
    const definitions = Array.isArray(raw)
        ? raw
        : Array.isArray(root?.blocks)
            ? root.blocks
            : typeof root?.type === 'string'
                ? [root]
                : [];
    if (definitions.length === 0 || definitions.length > 256) {
        throw new Error('block definitions must contain between 1 and 256 blocks');
    }
    const seenTypes = new Set<string>();
    definitions.forEach((definition, index) => {
        const record = asRecord(definition);
        const type = typeof record?.type === 'string' ? record.type : '';
        if (!SAFE_BLOCK_TYPE.test(type) || seenTypes.has(type)) {
            throw new Error(`block definition ${index} has an invalid or duplicate type`);
        }
        seenTypes.add(type);
    });
    return raw;
};

export const parseDeclarativeToolboxDocument = (source: string): unknown => {
    const raw = parseBoundedJson(source, 'toolbox');
    assertDeclarativeDataHasNoExternalResources(raw, 'toolbox');
    if (!raw || typeof raw !== 'object') throw new Error('toolbox root must be an object or array');
    return raw;
};

export const validateDeclarativeToolboxXml = (source: string): string => {
    const text = String(source ?? '').replace(/^\uFEFF/, '');
    if (utf8Bytes(text) > MAX_DOCUMENT_BYTES) {
        throw new Error('toolbox XML exceeds the 512 KiB limit');
    }
    if (!text.trim()) throw new Error('toolbox XML is empty');
    if (/<!\s*(?:DOCTYPE|ENTITY)\b|<\?xml-stylesheet\b/i.test(text)) {
        throw new Error('toolbox XML contains an external-entity or stylesheet declaration');
    }
    if (/<\s*(?:script|image|img|iframe|object|embed|link|style|foreignObject)\b/i.test(text)) {
        throw new Error('toolbox XML contains a resource-capable element');
    }
    if (/\b(?:src|href|xlink:href)\s*=/i.test(text) || textHasExternalResource(text)) {
        throw new Error('toolbox XML contains an external or inline resource reference');
    }
    if (/\b(?:callbackKey|custom)\s*=/i.test(text)) {
        throw new Error('toolbox XML may invoke a runtime callback');
    }
    return text;
};

const rejectUnknownKeys = (
    record: Record<string, unknown>,
    allowed: ReadonlySet<string>,
    location: string,
): void => {
    const unknown = Object.keys(record).filter(key => !allowed.has(key));
    if (unknown.length > 0) {
        throw new Error(`${location} contains unsupported fields: ${unknown.sort().join(', ')}`);
    }
};

const validateTemplate = (value: unknown, location: string): string => {
    if (typeof value !== 'string' || value.length === 0 || utf8Bytes(value) > MAX_TEMPLATE_LENGTH) {
        throw new Error(`${location} must be a non-empty bounded string`);
    }
    if (value.includes('\0')) throw new Error(`${location} contains a NUL byte`);

    const tokenLike = /\{\{([^{}]*)\}\}/g;
    let match: RegExpExecArray | null;
    while ((match = tokenLike.exec(value)) !== null) {
        const token = match[0];
        TEMPLATE_TOKEN.lastIndex = 0;
        const parsed = TEMPLATE_TOKEN.exec(token);
        if (!parsed || parsed[0] !== token || !SAFE_SYMBOL.test(parsed[2])) {
            throw new Error(`${location} contains an invalid placeholder: ${token}`);
        }
    }
    return value;
};

const normalizeArtifacts = (
    value: unknown,
    location: string,
): Readonly<Record<string, string>> => {
    if (typeof value === 'undefined') return Object.freeze({});
    const record = asRecord(value);
    if (!record) throw new Error(`${location} must be an object of key/template strings`);
    const entries = Object.entries(record);
    if (entries.length > MAX_ARTIFACTS_PER_SECTION) {
        throw new Error(`${location} contains too many entries`);
    }
    const normalized: Record<string, string> = Object.create(null);
    for (const [key, template] of entries) {
        if (!SAFE_ARTIFACT_KEY.test(key)) throw new Error(`${location} has an invalid key: ${key}`);
        normalized[key] = validateTemplate(template, `${location}.${key}`);
    }
    return Object.freeze(normalized);
};

export const parseDeclarativeGeneratorDocument = (
    source: string,
): Readonly<DeclarativeGeneratorDocumentV1> => {
    const raw = parseBoundedJson(source, 'ck-generator');
    const document = asRecord(raw);
    if (!document) throw new Error('ck-generator root must be an object');
    rejectUnknownKeys(document, new Set(['schema', 'version', 'rules']), 'ck-generator root');
    if (document.schema !== CK_GENERATOR_SCHEMA || document.version !== CK_GENERATOR_VERSION) {
        throw new Error('Unsupported ck-generator schema or version');
    }
    if (!Array.isArray(document.rules) || document.rules.length === 0 || document.rules.length > MAX_RULES) {
        throw new Error('ck-generator rules must be a non-empty bounded array');
    }

    const seenTypes = new Set<string>();
    let totalTemplateBytes = 0;
    const rules = document.rules.map((candidate, index) => {
        const rule = asRecord(candidate);
        if (!rule) throw new Error(`ck-generator rule ${index} must be an object`);
        rejectUnknownKeys(
            rule,
            new Set(['type', 'kind', 'template', 'order', 'includes', 'declarations', 'setup']),
            `ck-generator rule ${index}`,
        );
        const type = typeof rule.type === 'string' ? rule.type : '';
        if (!SAFE_BLOCK_TYPE.test(type) || seenTypes.has(type)) {
            throw new Error(`ck-generator rule ${index} has an invalid or duplicate block type`);
        }
        seenTypes.add(type);
        const kind = rule.kind;
        if (kind !== 'statement' && kind !== 'expression') {
            throw new Error(`ck-generator rule ${index} has an invalid kind`);
        }
        const rawOrder = typeof rule.order === 'undefined' ? 0 : rule.order;
        if (!Number.isSafeInteger(rawOrder) || Number(rawOrder) < 0 || Number(rawOrder) > 99) {
            throw new Error(`ck-generator rule ${index} has an invalid order`);
        }
        const template = validateTemplate(rule.template, `ck-generator rule ${index}.template`);
        const includes = normalizeArtifacts(rule.includes, `ck-generator rule ${index}.includes`);
        const declarations = normalizeArtifacts(rule.declarations, `ck-generator rule ${index}.declarations`);
        const setup = normalizeArtifacts(rule.setup, `ck-generator rule ${index}.setup`);
        totalTemplateBytes += utf8Bytes(template);
        for (const section of [includes, declarations, setup]) {
            for (const value of Object.values(section)) {
                totalTemplateBytes += utf8Bytes(value);
            }
        }
        if (totalTemplateBytes > MAX_TOTAL_TEMPLATE_BYTES) {
            throw new Error('ck-generator templates exceed the 384 KiB aggregate limit');
        }
        return Object.freeze({
            type,
            kind,
            template,
            order: Number(rawOrder),
            includes,
            declarations,
            setup,
        });
    });
    return Object.freeze({
        schema: CK_GENERATOR_SCHEMA,
        version: CK_GENERATOR_VERSION,
        rules: Object.freeze(rules),
    });
};

interface RenderBudget { remaining: number }

const renderTemplate = (
    template: string,
    block: any,
    generator: any,
    budget: RenderBudget,
): string => {
    const rendered = template.replace(TEMPLATE_TOKEN, (_token, kind: string, name: string) => {
        let fragment: string;
        if (kind === 'field') fragment = String(block?.getFieldValue?.(name) ?? '');
        else if (kind === 'field_json') fragment = JSON.stringify(String(block?.getFieldValue?.(name) ?? ''));
        else if (kind === 'statement') fragment = String(generator?.statementToCode?.(block, name) ?? '');
        else fragment = String(generator?.valueToCode?.(block, name, 0) ?? '').trim() || '0';
        if (utf8Bytes(fragment) > MAX_DYNAMIC_FRAGMENT_LENGTH) {
            throw new Error(`ck-generator placeholder ${kind}:${name} exceeds the 64 KiB limit`);
        }
        return fragment;
    });
    const renderedBytes = utf8Bytes(rendered);
    if (renderedBytes > MAX_RENDERED_TEMPLATE_LENGTH || renderedBytes > budget.remaining) {
        throw new Error('ck-generator rendered output exceeds its bounded invocation budget');
    }
    budget.remaining -= renderedBytes;
    return rendered;
};

const renderArtifacts = (
    rule: Readonly<DeclarativeGeneratorRuleV1>,
    block: any,
    generator: any,
    budget: RenderBudget,
): Record<'includes' | 'declarations' | 'setup', Array<[string, string]>> => {
    const rendered: Record<'includes' | 'declarations' | 'setup', Array<[string, string]>> = {
        includes: [],
        declarations: [],
        setup: [],
    };
    for (const section of ['includes', 'declarations', 'setup'] as const) {
        for (const [key, template] of Object.entries(rule[section])) {
            rendered[section].push([key, renderTemplate(template, block, generator, budget)]);
        }
    }
    return rendered;
};

export const createDeclarativeGeneratorFunction = (
    rule: Readonly<DeclarativeGeneratorRuleV1>,
): ((block: any) => string | [string, number]) => {
    const generate = (block: any): string | [string, number] => {
        const generator = (generate as any).__ckGenerator;
        const budget: RenderBudget = { remaining: MAX_RENDERED_INVOCATION_LENGTH };
        const code = renderTemplate(rule.template, block, generator, budget);
        const artifacts = renderArtifacts(rule, block, generator, budget);
        const prefix = `ck_decl_${rule.type}`;
        for (const [key, value] of artifacts.includes) {
            generator?.addInclude?.(`${prefix}_${key}`, value);
        }
        for (const [key, value] of artifacts.declarations) {
            generator?.addDeclaration?.(`${prefix}_${key}`, value);
        }
        for (const [key, value] of artifacts.setup) {
            generator?.addSetup?.(`${prefix}_${key}`, value);
        }
        return rule.kind === 'expression' ? [code, rule.order] : code;
    };
    (generate as any).__ckDeclarativeGenerator = true;
    (generate as any).__ckGeneratorRuleType = rule.type;
    return generate;
};

export const bindDeclarativeGeneratorFunction = (
    rule: Readonly<DeclarativeGeneratorRuleV1>,
    generator: any,
): ((block: any) => string | [string, number]) => {
    const generate = createDeclarativeGeneratorFunction(rule);
    (generate as any).__ckGenerator = generator;
    return generate;
};

const normalizedExtension = (path: string | null | undefined): string => {
    const value = String(path || '').trim().replace(/\\/g, '/');
    const name = value.slice(value.lastIndexOf('/') + 1).toLowerCase();
    const dot = name.lastIndexOf('.');
    return dot >= 0 ? name.slice(dot) : '';
};

export const isSafeDeclarativeEntrypoint = (
    path: string | null | undefined,
    kind: 'blocks' | 'generator' | 'toolbox',
): boolean => {
    const extension = normalizedExtension(path);
    if (kind === 'toolbox') return extension === '.json' || extension === '.xml';
    return extension === '.json';
};

export const isCompleteDeclarativeRuntime = (
    entrypoints: DeclarativeRuntimeEntrypoints | null | undefined,
): boolean => Boolean(
    entrypoints
    && isSafeDeclarativeEntrypoint(entrypoints.blocks, 'blocks')
    && isSafeDeclarativeEntrypoint(entrypoints.generator, 'generator')
    && isSafeDeclarativeEntrypoint(entrypoints.toolbox, 'toolbox')
);
