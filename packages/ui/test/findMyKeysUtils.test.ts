import assert from 'node:assert/strict';
import test from 'node:test';

import { findMyKeysCardView, findMyKeysImportOutcome } from '../src/app/utils/FindMyKeysUtils';

test('the card is hidden before macOS 14.4', () => {
    const view = findMyKeysCardView({ supported: false, status: null });

    assert.equal(view.visible, false);
});

const status = (keys: Record<'LocalStorage' | 'FMIP' | 'FMF', 'missing' | 'invalid' | 'ready'>) => {
    const states = Object.values(keys);
    const state = states.includes('missing') ? 'missing' : states.includes('invalid') ? 'invalid' : 'ready';
    return { supported: true, status: { state, keys } } as const;
};

test('a supported Mac shows the card with one row per key', () => {
    const view = findMyKeysCardView(status({ LocalStorage: 'ready', FMIP: 'missing', FMF: 'invalid' }));

    assert.equal(view.visible, true);
    assert.deepEqual(
        view.rows.map(row => [row.label, row.badge, row.color]),
        [
            ['Friend Locations (LocalStorage.key)', 'Ready', 'green'],
            ['Devices & Items (FMIPDataManager.bplist)', 'Missing', 'red'],
            ['Friend Names (FMFDataManager.bplist)', 'Invalid', 'orange']
        ]
    );
});

test('the overall summary reflects missing, invalid and ready', () => {
    assert.equal(
        findMyKeysCardView(status({ LocalStorage: 'ready', FMIP: 'missing', FMF: 'invalid' })).summary,
        'Some keys are missing. Import all three keys together.'
    );
    assert.equal(
        findMyKeysCardView(status({ LocalStorage: 'ready', FMIP: 'ready', FMF: 'invalid' })).summary,
        'Some keys are invalid. Extract them again, then import all three together.'
    );
    assert.equal(
        findMyKeysCardView(status({ LocalStorage: 'ready', FMIP: 'ready', FMF: 'ready' })).summary,
        'All three keys are imported and valid.'
    );
});

test('a supported Mac whose status is unavailable still shows the card, without key rows', () => {
    const view = findMyKeysCardView({ supported: true, status: null });

    assert.equal(view.visible, true);
    assert.deepEqual(view.rows, []);
    assert.equal(view.summary, 'Key status is unavailable.');
});

test('before the status has loaded, the card stays hidden', () => {
    assert.equal(findMyKeysCardView(null).visible, false);
});

test('cancelling the folder picker shows nothing and does not refresh', () => {
    assert.deepEqual(findMyKeysImportOutcome({ canceled: true, result: null }), { toast: null, refresh: false });
});

test('a successful import reports that all three keys were replaced together', () => {
    assert.deepEqual(findMyKeysImportOutcome({ canceled: false, result: { success: true } }), {
        toast: { kind: 'success', message: 'Imported all three Find My keys.' },
        refresh: true
    });
});

test('a failed import names the file and says the previous keys were kept', () => {
    const outcome = (file: string | null, reason: string) =>
        findMyKeysImportOutcome({ canceled: false, result: { success: false, file, reason } as any }).toast;

    assert.deepEqual(outcome('FMFDataManager.bplist', 'missing'), {
        kind: 'error',
        message: 'Nothing was imported: FMFDataManager.bplist is missing from that folder. Your previous keys are unchanged.'
    });
    assert.deepEqual(outcome('LocalStorage.key', 'invalid'), {
        kind: 'error',
        message: 'Nothing was imported: LocalStorage.key is not a valid key. Your previous keys are unchanged.'
    });
    assert.equal(
        outcome('/x/FindMyKeys', 'commit-failed')?.message,
        'Nothing was imported: the keys could not be saved. Your previous keys are unchanged.'
    );
    assert.equal(
        outcome(null, 'unavailable')?.message,
        'Nothing was imported: Find My key import is not available. Your previous keys are unchanged.'
    );
    assert.equal(
        outcome(null, 'error')?.message,
        'Nothing was imported: something went wrong. Your previous keys are unchanged.'
    );
});

test('a failed import still refreshes the status', () => {
    const result = { success: false, file: 'LocalStorage.key', reason: 'invalid' } as const;

    assert.equal(findMyKeysImportOutcome({ canceled: false, result }).refresh, true);
});
