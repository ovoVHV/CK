export type BlockDebugPhase = 'compiling' | 'connecting' | 'running' | 'paused' | 'stopping';

export interface BlockDebugSessionState {
    active: boolean;
    sessionId: string;
    phase: BlockDebugPhase;
    pausedBlockId: string | null;
    pausedBlockLabel: string;
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
 * token map alive. Paused-block details are retained so a successful reconnect
 * can restore the controls even when the firmware does not emit READY again.
 */
export const markBlockDebugSessionConnecting = (
    session: BlockDebugSessionState,
): BlockDebugSessionState => {
    if (!session.active || session.phase === 'stopping') return session;
    return {
        ...session,
        phase: 'connecting',
    };
};

/**
 * Opening the serial endpoint is enough to leave the transient connecting
 * state. A paused firmware repeatedly announces PAUSED, but restoring its last
 * known block immediately avoids flashing a false running state in the UI.
 */
export const markBlockDebugSessionReconnected = (
    session: BlockDebugSessionState,
): BlockDebugSessionState => {
    if (!session.active || session.phase !== 'connecting') return session;
    return {
        ...session,
        phase: session.pausedBlockId ? 'paused' : 'running',
    };
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
