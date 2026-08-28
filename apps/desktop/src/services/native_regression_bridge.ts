export const CK_NATIVE_REGRESSION_BRIDGE_NAME = 'CK_NATIVE_REGRESSION' as const;
export const CK_NATIVE_REGRESSION_BRIDGE_VERSION = 1 as const;

export interface CKNativeRegressionContext<TBlockly = unknown, TWorkspace = unknown> {
    readonly Blockly: TBlockly;
    readonly workspace: TWorkspace;
}

export interface CKNativeRegressionBridge<TBlockly = unknown, TWorkspace = unknown> {
    readonly schemaVersion: typeof CK_NATIVE_REGRESSION_BRIDGE_VERSION;
    /**
     * Returns only the Blockly objects owned by the currently mounted CK
     * workspace. A disposed bridge returns null instead of retaining a usable
     * handle to an old workspace.
     */
    getCurrent(): Readonly<CKNativeRegressionContext<TBlockly, TWorkspace>> | null;
}

export type RemoveNativeRegressionBridge = () => void;

/**
 * Exposes the minimum page-local hook required by CK's native CDP regression
 * runner. This is not a command channel: it has no transport, evaluator,
 * package access, or callback registration surface.
 */
export const installNativeRegressionBridge = <TBlockly, TWorkspace>(
    host: object,
    Blockly: TBlockly,
    workspace: TWorkspace,
): RemoveNativeRegressionBridge => {
    const target = host as Record<string, unknown>;
    let active = true;
    const context = Object.freeze({ Blockly, workspace });
    const bridge: CKNativeRegressionBridge<TBlockly, TWorkspace> = Object.freeze({
        schemaVersion: CK_NATIVE_REGRESSION_BRIDGE_VERSION,
        getCurrent: () => active ? context : null,
    });

    Object.defineProperty(target, CK_NATIVE_REGRESSION_BRIDGE_NAME, {
        configurable: true,
        enumerable: false,
        writable: false,
        value: bridge,
    });

    return () => {
        active = false;
        // A newer mounted workspace may already own the global name. Never let
        // cleanup from the old component remove the newer bridge.
        if (target[CK_NATIVE_REGRESSION_BRIDGE_NAME] === bridge) {
            Reflect.deleteProperty(target, CK_NATIVE_REGRESSION_BRIDGE_NAME);
        }
    };
};
