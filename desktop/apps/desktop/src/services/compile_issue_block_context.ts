const isEnUi = (): boolean => {
    try {
        const lang = typeof document !== 'undefined' ? document.documentElement?.lang : '';
        const stored = typeof window !== 'undefined' ? window.localStorage?.getItem('ck.i18n.uiLocale') : '';
        return /^en(?:-|$)/i.test(String(lang || stored || ''));
    } catch { return false; }
};
const uiText = (zh: string, en: string): string => (isEnUi() ? en : zh);
import type {
    CompileIssueBlockContext,
    CompileIssueCard,
} from './compile_issue_cards';
import type {
    CompileSourceMapMappingV1,
    CompileSourceMapV1,
    CompileSourceSection,
} from './compile_source_map';
import {
    lookupCompileSourceMap,
    resolveTrustedCompileDiagnosticFile,
    sha256Hex,
    type TrustedCompileSketchAliasV1,
} from './compile_source_map';

interface BlocklyBlockLike {
    id?: string;
    type?: string;
    previousConnection?: unknown;
    nextConnection?: unknown;
    toString?: (maxLength?: number, emptyToken?: string) => string;
    getPreviousBlock?: () => BlocklyBlockLike | null;
    getSurroundParent?: () => BlocklyBlockLike | null;
}

interface BlocklyWorkspaceLike {
    getBlockById: (blockId: string) => BlocklyBlockLike | null;
}

export interface CompileIssueBlockPresentation {
    blockId: string;
    blockType: string;
    label: string;
    section: CompileSourceSection;
    flowPosition: string;
}

export interface ReconcileCompileIssueBlockContextsInput {
    issues: readonly CompileIssueCard[];
    sourceMap: Readonly<CompileSourceMapV1>;
    compileCode: string;
    currentCode: string;
    runId: string;
    alias: TrustedCompileSketchAliasV1 | null | undefined;
    presentations: ReadonlyMap<string, Readonly<CompileIssueBlockPresentation>>;
}

const TRUSTED_MAPPING_CONFIDENCE = new Set(['exact', 'high']);

const presentationKey = (
    blockId: string,
    blockType: string,
    section: CompileSourceSection,
): string => `${blockId}\u0000${blockType}\u0000${section}`;

const sectionLabelFor = (section: CompileSourceSection): string => {
    if (section === 'setup') return uiText('初始化流程', 'Setup');
    if (section === 'loop') return uiText('主循环', 'Loop');
    if (section === 'definition') return uiText('定义区', 'Definitions');
    if (section === 'expression') return uiText('表达式', 'Expression');
    return uiText('未知流程', 'Unknown section');
};

const compactBlockLabel = (block: BlocklyBlockLike, maxLength = 72): string => {
    try {
        const label = String(block.toString?.(maxLength, '') || '')
            .replace(/\s+/g, ' ')
            .trim();
        if (label) return label;
    } catch {
        // A third-party block renderer must not break compilation diagnostics.
    }
    return String(block.type || uiText('未命名积木', 'Unnamed block'));
};

const chainOrdinal = (block: BlocklyBlockLike): number | null => {
    try {
        if (!block.previousConnection && !block.nextConnection) return null;
        let ordinal = 1;
        let cursor = typeof block.getPreviousBlock === 'function'
            ? block.getPreviousBlock()
            : null;
        const visited = new Set<BlocklyBlockLike>();
        while (cursor && !visited.has(cursor) && ordinal < 10_000) {
            visited.add(cursor);
            ordinal += 1;
            cursor = typeof cursor.getPreviousBlock === 'function'
                ? cursor.getPreviousBlock()
                : null;
        }
        // A corrupted third-party connection cycle or implausibly deep chain is
        // not evidence for a user-facing ordinal.
        return cursor ? null : ordinal;
    } catch {
        return null;
    }
};

const flowPositionFor = (
    block: BlocklyBlockLike,
    section: CompileSourceSection,
): string => {
    const sectionLabel = sectionLabelFor(section);
    const ordinal = chainOrdinal(block);
    if (ordinal == null) return sectionLabel;

    let parent: BlocklyBlockLike | null = null;
    try {
        parent = block.getSurroundParent?.() || null;
    } catch {
        parent = null;
    }
    const parentLabel = parent ? compactBlockLabel(parent, 36) : '';
    return parentLabel
        ? uiText(`${sectionLabel} · “${parentLabel}”内第 ${ordinal} 项`, `${sectionLabel} · item #${ordinal} inside "${parentLabel}"`)
        : uiText(`${sectionLabel} · 当前积木链第 ${ordinal} 项`, `${sectionLabel} · block #${ordinal} in chain`);
};

/**
 * Freeze user-facing block names and structural positions alongside the exact
 * compile source map. Reading the live workspace after the compiler returns
 * could otherwise show field values edited after this build started.
 */
export const captureCompileIssueBlockPresentations = (
    workspace: BlocklyWorkspaceLike | null | undefined,
    sourceMap: Readonly<CompileSourceMapV1>,
): ReadonlyMap<string, Readonly<CompileIssueBlockPresentation>> => {
    const presentations = new Map<string, Readonly<CompileIssueBlockPresentation>>();
    if (!workspace) return presentations;

    for (const mapping of sourceMap.mappings) {
        const key = presentationKey(mapping.blockId, mapping.blockType, mapping.section);
        if (presentations.has(key)) continue;
        if (!TRUSTED_MAPPING_CONFIDENCE.has(mapping.confidence)) continue;
        const block = workspace.getBlockById(mapping.blockId);
        if (!block || String(block.id || '') !== mapping.blockId) continue;
        presentations.set(key, Object.freeze({
            blockId: mapping.blockId,
            blockType: mapping.blockType,
            label: compactBlockLabel(block),
            section: mapping.section,
            flowPosition: flowPositionFor(block, mapping.section),
        }));
    }
    return presentations;
};

/**
 * Bind an issue to a block only when the compiler source line, immutable map,
 * trusted mapping confidence and frozen block presentation all agree.
 */
export const resolveCompileIssueBlockContext = (
    issue: CompileIssueCard,
    mapping: Readonly<CompileSourceMapMappingV1> | null | undefined,
    presentations: ReadonlyMap<string, Readonly<CompileIssueBlockPresentation>>,
): CompileIssueBlockContext | undefined => {
    if (!mapping || issue.sourceLine == null) return undefined;
    if (!TRUSTED_MAPPING_CONFIDENCE.has(mapping.confidence)) return undefined;
    if (issue.sourceLine < mapping.lineStart || issue.sourceLine > mapping.lineEnd) return undefined;
    const presentation = presentations.get(presentationKey(
        mapping.blockId,
        mapping.blockType,
        mapping.section,
    ));
    if (!presentation) return undefined;
    if (
        presentation.blockType !== mapping.blockType
        || presentation.section !== mapping.section
    ) return undefined;

    return {
        blockId: presentation.blockId,
        blockType: presentation.blockType,
        label: presentation.label,
        section: presentation.section,
        sourceLine: issue.sourceLine,
        flowLocation: uiText(`${presentation.flowPosition} · 源码第 ${issue.sourceLine} 行`, `${presentation.flowPosition} · source line ${issue.sourceLine}`),
        confidence: mapping.confidence as 'exact' | 'high',
    };
};

const issueSketchFile = (issue: CompileIssueCard): string | null => {
    const explicit = String(issue.sourceFile || '').trim();
    if (/\.ino(?:\.cpp)?$/i.test(explicit)) return explicit;
    const match = String(issue.rawDiagnostic || issue.evidence || '').match(
        /^\s*(.+?\.ino(?:\.cpp)?):\d+(?::\d+)?:\s*(?:fatal\s+error|error|warning)\s*:/i,
    );
    return match ? String(match[1] || '').trim() : null;
};

/**
 * Add (or revoke) block context from a backend-authenticated sketch alias.
 *
 * This function is deliberately idempotent so the UI can call it both when a
 * compiler issue arrives and when the independently delivered alias event
 * arrives. That removes event-order dependence without ever accepting a path
 * merely because its basename looks like a CK sketch.
 */
export const reconcileCompileIssueBlockContexts = (
    input: ReconcileCompileIssueBlockContextsInput,
): CompileIssueCard[] => {
    const currentHashMatches = sha256Hex(String(input.currentCode || ''))
        === input.sourceMap.codeSha256;

    return input.issues.map((issue) => {
        // Never retain context that cannot be re-proved against the current
        // alias, source map, run and editor snapshot (including revocation).
        const { blockContext: _staleContext, ...withoutContext } = issue;
        if (!currentHashMatches || issue.sourceLine == null) return withoutContext;

        const diagnosticFile = issueSketchFile(issue);
        if (!diagnosticFile) return withoutContext;
        const logicalFile = resolveTrustedCompileDiagnosticFile({
            alias: input.alias,
            runId: input.runId,
            sourceMap: input.sourceMap,
            diagnosticFile,
        });
        if (!logicalFile) return withoutContext;

        const mapping = lookupCompileSourceMap(input.sourceMap, {
            file: logicalFile,
            line: issue.sourceLine,
            code: input.compileCode,
            acceptedConfidences: ['exact', 'high'],
        });
        const blockContext = resolveCompileIssueBlockContext(
            issue,
            mapping,
            input.presentations,
        );
        return blockContext ? { ...withoutContext, blockContext } : withoutContext;
    });
};
