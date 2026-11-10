/**
 * Remembers an async value for `ttlMs`; callers that arrive while it is being
 * fetched share that one fetch. A failed fetch is not remembered.
 */
export const cachedValue = <T>(ttlMs: number, fetch: () => Promise<T>, now: () => number = Date.now) => {
    let value: { at: number; result: T } | null = null;
    let pending: Promise<T> | null = null;

    return (): Promise<T> => {
        if (value && now() - value.at < ttlMs) return Promise.resolve(value.result);
        if (pending) return pending;
        pending = fetch()
            .then(result => {
                value = { at: now(), result };
                return result;
            })
            .finally(() => {
                pending = null;
            });
        return pending;
    };
};
