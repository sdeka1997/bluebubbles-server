export type FindMyKeyType = 'LocalStorage' | 'FMIP' | 'FMF';
export type FindMyKeyState = 'missing' | 'invalid' | 'ready';

export type FindMyKeysStatus = {
    state: FindMyKeyState;
    keys: Record<FindMyKeyType, FindMyKeyState>;
};

export type FindMyKeysStatusResponse = {
    /** True on macOS 14.4+, where the keys are needed */
    supported: boolean;
    status: FindMyKeysStatus | null;
};

export type FindMyKeysImportResult =
    | { success: true }
    | {
          success: false;
          /** The offending key file name, or null when no single file is to blame */
          file: string | null;
          reason: 'missing' | 'invalid' | 'commit-failed' | 'unavailable' | 'error';
      };

export type FindMyKeysImportResponse = {
    canceled: boolean;
    result: FindMyKeysImportResult | null;
};

export type FindMyKeysImportOutcome = {
    toast: { kind: 'success' | 'error'; message: string } | null;
    /** Whether the card should reload the key status */
    refresh: boolean;
};

export type FindMyKeyRow = {
    label: string;
    badge: string;
    color: string;
};

export type FindMyKeysCardView = {
    visible: boolean;
    rows: FindMyKeyRow[];
    summary: string;
};

const KEY_LABELS: Record<FindMyKeyType, string> = {
    LocalStorage: 'Friend Locations (LocalStorage.key)',
    FMIP: 'Devices & Items (FMIPDataManager.bplist)',
    FMF: 'Friend Names (FMFDataManager.bplist)'
};

const BADGES: Record<FindMyKeyState, { badge: string; color: string }> = {
    missing: { badge: 'Missing', color: 'red' },
    invalid: { badge: 'Invalid', color: 'orange' },
    ready: { badge: 'Ready', color: 'green' }
};

const SUMMARIES: Record<FindMyKeyState, string> = {
    missing: 'Some keys are missing. Import all three keys together.',
    invalid: 'Some keys are invalid. Extract them again, then import all three together.',
    ready: 'All three keys are imported and valid.'
};

/**
 * What the Find My keys card shows for a `get-findmy-keys-status` response.
 * Pass null while the status is still loading.
 */
export const findMyKeysCardView = (response: FindMyKeysStatusResponse | null): FindMyKeysCardView => {
    if (!response?.supported) return { visible: false, rows: [], summary: '' };
    if (!response.status) return { visible: true, rows: [], summary: 'Key status is unavailable.' };

    const { keys, state } = response.status;
    const rows = (Object.keys(KEY_LABELS) as FindMyKeyType[]).map(type => ({
        label: KEY_LABELS[type],
        ...BADGES[keys[type]]
    }));
    return { visible: true, rows, summary: SUMMARIES[state] };
};

const failureDetail = (file: string | null, reason: string): string => {
    if (reason === 'missing') return `${file} is missing from that folder`;
    if (reason === 'invalid') return `${file} is not a valid key`;
    if (reason === 'commit-failed') return 'the keys could not be saved';
    if (reason === 'unavailable') return 'Find My key import is not available';
    return 'something went wrong';
};

/**
 * What the card does after an `import-findmy-keys` call. The import is all-or-nothing,
 * so there is exactly one message: all three keys were imported, or none were.
 */
export const findMyKeysImportOutcome = (response: FindMyKeysImportResponse): FindMyKeysImportOutcome => {
    if (response.canceled || !response.result) return { toast: null, refresh: false };

    const result = response.result;
    if (result.success) {
        return { toast: { kind: 'success', message: 'Imported all three Find My keys.' }, refresh: true };
    }

    const message = `Nothing was imported: ${failureDetail(result.file, result.reason)}. Your previous keys are unchanged.`;
    return { toast: { kind: 'error', message }, refresh: true };
};
