export interface BlocklyChangeEventLike {
    type?: unknown;
    isUiEvent?: unknown;
}

const IGNORED_NON_CONTENT_EVENT_TYPES = new Set([
    'ui',
    'viewport_change',
    'finished_loading',
    // Blockly emits the final, committed value as a regular `change` event.
    'block_field_intermediate_change',
]);

/**
 * Blockly 12 gives UI events their own concrete types (`selected`, `click`,
 * and so on), so comparing only against the legacy `ui` type is insufficient.
 * Workspace loading is not marked as a UI event, but it is not an edit either.
 */
export const shouldProcessBlocklyContentEvent = (
    event: BlocklyChangeEventLike | null | undefined,
): boolean => {
    if (!event || event.isUiEvent === true) return false;
    const type = String(event.type || '').trim();
    return Boolean(type) && !IGNORED_NON_CONTENT_EVENT_TYPES.has(type);
};

export const hasGeneratedCodeChanged = (
    previousCode: string,
    nextCode: string,
): boolean => previousCode !== nextCode;

/**
 * Resolve the source that a user-triggered compile/upload must use.
 *
 * Blockly is the source of truth whenever its workspace exists. React state is
 * intentionally only a fallback for the short interval before injection: project
 * deserialization can complete without emitting a content event, which otherwise
 * leaves the preview state older than the visible blocks.
 */
export const resolveCompileSource = <TWorkspace>(
    codeOverride: string | undefined,
    workspace: TWorkspace | null | undefined,
    generateWorkspaceCode: (workspace: TWorkspace) => string,
    fallbackCode: string,
): string => {
    if (codeOverride !== undefined) return codeOverride;
    if (workspace) return generateWorkspaceCode(workspace);
    return fallbackCode;
};
