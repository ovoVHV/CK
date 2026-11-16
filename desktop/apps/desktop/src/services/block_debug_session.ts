export type BlockDebugPhase = 'compiling' | 'connecting' | 'running' | 'paused' | 'stopping' | 'unresponsive';

export interface BlockDebugSessionState {
    active: boolean;
    sessionId: string;
    phase: BlockDebugPhase;
    pausedBlockId: string | null;
    pausedBlockLabel: string;
    pendingCommand?: 'CONTINUE' | 'STEP' | null;
}

export const IDLE_BLOCK_DEBUG_SESSION: BlockDebugSessionState = {
    active: false,
    sessionId: '',
    phase: 'running',
    pausedBlockId: null,
    pausedBlockLabel: '',
};

/**
 * A serial disconnect is recoverable. Keep the session identity and runtime
 * token map alive. Old pause state is not proof of the device's current state.
 */
export const markBlockDebugSessionConnecting = (
    session: BlockDebugSessionState,
): BlockDebugSessionState => {
    if (!session.active || session.phase === 'stopping') return session;
    return {
        ...session,
        phase: 'connecting',
        pausedBlockId: null,
        pausedBlockLabel: '',
        pendingCommand: null,
    };
};

/**
 * Opening the serial endpoint alone does not establish execution state.
 * Keep waiting for ATTACHED with explicit state or a fresh PAUSED frame.
 */
export const markBlockDebugSessionReconnected = (
    session: BlockDebugSessionState,
): BlockDebugSessionState => {
    return session;
};

/**
 * Only the session for which STOP was successfully written may enter the
 * acknowledgement-waiting state. A late completion from an older request
 * must not revive or mutate a newer session.
 */
export const markBlockDebugSessionStopping = (
    session: BlockDebugSessionState,
    expectedSessionId: string,
): BlockDebugSessionState => {
    if (
        !session.active
        || session.sessionId !== expectedSessionId
    ) return session;
    return {
        ...session,
        phase: 'stopping',
    };
};
