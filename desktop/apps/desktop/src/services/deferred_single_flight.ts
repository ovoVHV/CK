export interface DeferredSingleFlightOptions {
    nextOwnerToken: () => number;
    runLatest: (ownerToken: number) => Promise<boolean>;
    onOwnerSettled?: (ownerToken: number, lastResult: boolean) => void;
}

export interface DeferredSingleFlightQueue {
    request: () => Promise<boolean>;
    activeOwnerToken: () => number | null;
}

interface ActiveOwner {
    token: number;
    rerunRequested: boolean;
    promise: Promise<boolean>;
}

/**
 * Runs one operation at a time while coalescing requests received during the
 * active pass into one trailing pass. The trailing pass calls runLatest again,
 * so callers do not accidentally persist the first pass's stale render state.
 */
export const createDeferredSingleFlightQueue = (
    options: DeferredSingleFlightOptions,
): DeferredSingleFlightQueue => {
    let activeOwner: ActiveOwner | null = null;

    const request = (): Promise<boolean> => {
        if (activeOwner) {
            activeOwner.rerunRequested = true;
            return activeOwner.promise;
        }

        const owner: ActiveOwner = {
            token: options.nextOwnerToken(),
            rerunRequested: false,
            promise: Promise.resolve(false),
        };
        activeOwner = owner;
        owner.promise = (async () => {
            let lastResult = false;
            try {
                do {
                    owner.rerunRequested = false;
                    lastResult = await options.runLatest(owner.token);
                } while (owner.rerunRequested);
                return lastResult;
            } finally {
                try {
                    options.onOwnerSettled?.(owner.token, lastResult);
                } finally {
                    if (activeOwner?.token === owner.token) {
                        activeOwner = null;
                    }
                }
            }
        })();
        return owner.promise;
    };

    return {
        request,
        activeOwnerToken: () => activeOwner?.token ?? null,
    };
};
