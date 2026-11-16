interface BlocklyOverlays {
    WidgetDiv: { hide: () => void };
    DropDownDiv: { hideWithoutAnimation: () => void };
    Tooltip: { hide: () => void };
}

// Blockly owns interactions within these surfaces, including its portalled
// field editors. CK owns interactions with the surrounding application.
const BLOCKLY_SURFACE = '.blocklyInjectionDiv, .blocklyWidgetDiv, .blocklyDropDownDiv';
const MODAL = '[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]';

/**
 * Finish field editing when control moves from Blockly into CK or another
 * window. WidgetDiv.hide() commits the validated value and fires Blockly's
 * final change event; removing the input or hiding it with CSS would not.
 */
export const installBlocklyOverlayLifecycle = (
    blockly: BlocklyOverlays,
    doc: Document,
): (() => void) => {
    const view = doc.defaultView;
    if (!view) return () => undefined;
    let dismissing = false;

    const dismiss = () => {
        if (dismissing) return;
        dismissing = true;
        const active = doc.activeElement;
        // Blockly restores its own ephemeral focus when closing an editor.
        // If a dialog/search input already took focus, keep it there.
        const keepFocus = active instanceof view.HTMLElement
            && active !== doc.body && !active.closest(BLOCKLY_SURFACE)
            ? active : null;
        try {
            blockly.WidgetDiv.hide();
            blockly.DropDownDiv.hideWithoutAnimation();
            blockly.Tooltip.hide();
        } finally {
            if (keepFocus?.isConnected && doc.activeElement !== keepFocus) {
                keepFocus.focus({ preventScroll: true });
            }
            dismissing = false;
        }
    };

    const onExternalInteraction = (event: Event) => {
        // composedPath also handles clicks on nested SVG icons/shadow hosts.
        if (event.composedPath().some(target => (
            target instanceof view.Element && target.closest(BLOCKLY_SURFACE)
        ))) return;
        dismiss();
    };
    const onVisibilityChange = () => {
        if (doc.hidden) dismiss();
    };

    // Capture runs before the toolbar action opens its menu/dialog. Focus also
    // covers keyboard navigation and programmatic focus changes.
    doc.addEventListener('pointerdown', onExternalInteraction, true);
    doc.addEventListener('focusin', onExternalInteraction, true);
    view.addEventListener('blur', dismiss);
    doc.addEventListener('visibilitychange', onVisibilityChange);

    // Async/keyboard actions can mount a modal without a pointer or focus
    // event. Close before the next paint, but never on ordinary modal updates
    // (a recovery dialog may itself contain an editable Blockly preview).
    const observer = new view.MutationObserver(records => {
        for (const record of records) {
            if (record.target instanceof view.Element && record.target.closest(BLOCKLY_SURFACE)) continue;
            if (record.type === 'attributes') {
                if (record.target instanceof view.Element && record.target.matches(MODAL)) {
                    dismiss();
                    return;
                }
            } else if (Array.from(record.addedNodes).some(node => (
                node instanceof view.Element && (node.matches(MODAL) || node.querySelector(MODAL))
            ))) {
                dismiss();
                return;
            }
        }
    });
    observer.observe(doc.body, {
        childList: true, subtree: true, attributes: true, attributeFilter: ['role', 'aria-modal'],
    });

    return () => {
        observer.disconnect();
        doc.removeEventListener('pointerdown', onExternalInteraction, true);
        doc.removeEventListener('focusin', onExternalInteraction, true);
        view.removeEventListener('blur', dismiss);
        doc.removeEventListener('visibilitychange', onVisibilityChange);
    };
};
