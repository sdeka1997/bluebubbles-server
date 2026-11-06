/** Longest phone number or email Apple accepts is well under this; anything longer is not a handle. */
export const FIND_MY_LIVE_HANDLE_LIMIT = 320;

/** The request body itself is malformed (HTTP 400). */
export class FindMyLiveTrackingInputError extends Error {}

/** The handle is not uniquely present in the Find My roster (HTTP 404). */
export class FindMyLiveTrackingNotFound extends Error {
    constructor() {
        super("That Apple handle is not uniquely present in the Find My roster");
    }
}

/** A live-tracking request must explicitly start/switch with a string or stop with null. */
export const findMyLiveTrackingHandle = (body: unknown): string | null => {
    if (!body || typeof body !== "object" || !("handle" in body)) {
        throw new FindMyLiveTrackingInputError("Find My live tracking requires a handle field");
    }
    const handle = (body as { handle?: unknown }).handle;
    if (handle === null) return null;
    if (typeof handle !== "string") {
        throw new FindMyLiveTrackingInputError("Find My live tracking handle must be a string or null");
    }
    if (handle.trim().length === 0) {
        throw new FindMyLiveTrackingInputError("Find My live tracking handle must not be empty");
    }
    if (handle.length > FIND_MY_LIVE_HANDLE_LIMIT) {
        throw new FindMyLiveTrackingInputError("Find My live tracking handle is too long");
    }
    return handle;
};

export const findMyLiveTrackingFailureStatus = (error: unknown): 400 | 404 | 500 => {
    if (error instanceof FindMyLiveTrackingInputError) return 400;
    if (error instanceof FindMyLiveTrackingNotFound) return 404;
    return 500;
};
