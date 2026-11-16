import { baseBoardFqbn } from './board_fqbn';

const DETAILS_CACHE = new Map<string, unknown>();
const DETAILS_REQUESTS = new Map<string, Promise<unknown>>();
let cacheGeneration = 0;

const cacheKeyForBoard = (fqbn: string): string => baseBoardFqbn(fqbn).toLowerCase();

export class BoardDetailsCacheInvalidatedError extends Error {
    constructor(fqbn: string) {
        super(`Board details request invalidated for ${fqbn}`);
        this.name = 'BoardDetailsCacheInvalidatedError';
    }
}

/** One Arduino CLI board-details request per base FQBN for the current core state. */
export const getBoardDetailsCached = async (fqbn: string): Promise<any> => {
    const baseFqbn = baseBoardFqbn(fqbn);
    const cacheKey = cacheKeyForBoard(baseFqbn);
    if (DETAILS_CACHE.has(cacheKey)) return DETAILS_CACHE.get(cacheKey);
    const pending = DETAILS_REQUESTS.get(cacheKey);
    if (pending) return pending;

    const requestGeneration = cacheGeneration;
    const request = (async () => {
        const { invoke } = await import('@tauri-apps/api/core');
        const raw = await invoke('get_board_details', { fqbn: baseFqbn });
        // Clearing a cache must also revoke results from requests that were
        // already in flight. Returning those details would let a caller
        // publish an obsolete boards.txt schema after a core refresh.
        if (requestGeneration !== cacheGeneration) {
            throw new BoardDetailsCacheInvalidatedError(baseFqbn);
        }
        const details = JSON.parse(String(raw || '{}'));
        DETAILS_CACHE.set(cacheKey, details);
        return details;
    })();
    DETAILS_REQUESTS.set(cacheKey, request);
    try {
        return await request;
    } finally {
        if (DETAILS_REQUESTS.get(cacheKey) === request) DETAILS_REQUESTS.delete(cacheKey);
    }
};

/** Core/package installation can change defaults and allowed option values. */
export const clearBoardDetailsCache = (): void => {
    cacheGeneration += 1;
    DETAILS_CACHE.clear();
    DETAILS_REQUESTS.clear();
};
