export interface BlocklyOwnedFlyoutLike {
    targetWorkspace?: BlocklyWorkspaceLifecycleLike | null;
    dispose: () => void;
}

export interface BlocklyWorkspaceLifecycleLike {
    trashcan?: {
        flyout?: BlocklyOwnedFlyoutLike | null;
    } | null;
    dispose: () => void;
}

export interface BlocklyMainWorkspaceRegistry {
    getMainWorkspace: () => unknown;
    setMainWorkspace: (workspace: unknown | null) => void;
}

export interface BlocklyWidgetDivSingletonLike {
    hide?: () => void;
    getDiv?: () => HTMLElement | null;
}

export interface BlocklyPreviewWorkspaceLifecycleLike {
    dispose: () => void;
}

export interface BlocklyPreviewTargetWorkspaceLike {
    getInjectionDiv?: () => { isConnected?: boolean } | null;
}

/**
 * Blockly 12 reuses the process-wide `.blocklyWidgetDiv`, but every inject()
 * calls WidgetDiv.createDom() and unconditionally binds another keydown
 * wrapper to that same element. Blockly does not expose the wrapper needed to
 * unbind it. Replace the hidden singleton before the next injection so
 * createDom() adopts the clean clone and installs exactly one wrapper.
 */
export const prepareBlocklyWidgetDivForInjection = (
    widgetDiv: BlocklyWidgetDivSingletonLike | null | undefined,
): void => {
    if (!widgetDiv) return;

    try {
        widgetDiv.hide?.();
    } catch (error) {
        console.warn('[BlocklyLifecycle] Failed to hide the shared widget div', error);
    }

    try {
        const current = widgetDiv.getDiv?.() || null;
        const parent = current?.parentNode;
        if (!current || !parent) return;
        parent.replaceChild(current.cloneNode(false), current);
    } catch (error) {
        console.warn('[BlocklyLifecycle] Failed to refresh the shared widget div', error);
    }
};

/**
 * Dispose a short-lived preview workspace without reviving an old main
 * workspace. Blockly.inject() temporarily promotes every preview to main, so
 * restore the target only while the preview still owns that pointer and the
 * target remains attached. A newer owner is always left untouched.
 */
export const disposeBlocklyPreviewWorkspaceLifecycle = (
    previewWorkspace: BlocklyPreviewWorkspaceLifecycleLike,
    targetWorkspace: BlocklyPreviewTargetWorkspaceLike | null | undefined,
    registry: BlocklyMainWorkspaceRegistry,
): void => {
    const previewOwnedMainWorkspace = registry.getMainWorkspace() === previewWorkspace;
    try {
        previewWorkspace.dispose();
    } finally {
        if (!previewOwnedMainWorkspace) return;
        // Blockly may clear the global pointer while disposing. Restore the
        // target only when no newer workspace has claimed it in the meantime.
        const currentMainWorkspace = registry.getMainWorkspace();
        if (currentMainWorkspace !== null && currentMainWorkspace !== previewWorkspace) return;
        const targetIsConnected = targetWorkspace?.getInjectionDiv?.()?.isConnected === true;
        registry.setMainWorkspace(targetIsConnected ? targetWorkspace : null);
    }
};

/**
 * Blockly 12's Trashcan.dispose does not dispose its contents flyout. That
 * flyout owns a registered WorkspaceSvg and retains the already-disposed main
 * workspace through targetWorkspace. Dispose it explicitly before the main
 * workspace, then clear Blockly's global main-workspace pointer only if this
 * workspace still owns it.
 */
export const disposeBlocklyWorkspaceLifecycle = (
    workspace: BlocklyWorkspaceLifecycleLike,
    registry: BlocklyMainWorkspaceRegistry,
): void => {
    const trashcan = workspace.trashcan;
    const flyout = trashcan?.flyout || null;
    if (flyout && (flyout.targetWorkspace == null || flyout.targetWorkspace === workspace)) {
        try {
            flyout.dispose();
        } catch (error) {
            console.warn('[BlocklyLifecycle] Failed to dispose trashcan flyout', error);
        } finally {
            if (trashcan?.flyout === flyout) trashcan.flyout = null;
        }
    }

    const ownedMainWorkspace = registry.getMainWorkspace() === workspace;
    try {
        workspace.dispose();
    } finally {
        if (ownedMainWorkspace && registry.getMainWorkspace() === workspace) {
            registry.setMainWorkspace(null);
        }
    }
};
