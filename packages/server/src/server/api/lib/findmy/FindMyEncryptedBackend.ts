import { startBackgroundFindMyRefresh } from "./BackgroundFindMyRefresh";
import { buildEncryptedFriendItems, EncryptedFriendLocation } from "./EncryptedFriendMapper";
import { buildFindMyRoster } from "./FindMyFriendRoster";
import { FindMyFriendsCache } from "./FindMyFriendsCache";
import { FindMyLocationItem } from "./types";

/** Everything the macOS 14.4+ friends refresh touches, injected so it can be tested without Electron. */
export type EncryptedFriendsBackend = {
    loadLocalStorageKey: () => Buffer | null;
    loadFmfKey: () => Promise<Buffer | null>;
    /** Decrypted FriendCacheData payload (readFmfRosterData) */
    readRosterData: (fmfKey: Buffer) => any;
    /** Friend coordinates from the decrypted LocalStorage.db (readFriendLocations) */
    readLocations: (localStorageKey: Buffer) => EncryptedFriendLocation[];
    cache: Pick<FindMyFriendsCache, "setRoster" | "addAll" | "getAll">;
    /** Adds addresses for the response, within its time budget */
    label: (locations: FindMyLocationItem[]) => Promise<FindMyLocationItem[]>;
    /** Quits, relaunches and re-hides Find My so it fetches fresh locations */
    bounce: () => Promise<void>;
    isFindMyRunning: () => Promise<boolean>;
    quitFindMy: () => Promise<void>;
    /** Labels, stores and emits the locations that changed (the new-findmy-location path) */
    publish: (locations: FindMyLocationItem[]) => Promise<void>;
    log: (message: string) => void;
};

/**
 * Friends refresh for macOS 14.4+, where Find My keeps the friend list (FMF cache) and
 * friend coordinates (LocalStorage.db) encrypted. Returns the current decrypted snapshot
 * right away; a coalesced background bounce of Find My then re-reads and publishes changes.
 */
export const refreshEncryptedFriends = async (
    backend: EncryptedFriendsBackend,
    openFindMyApp = true
): Promise<FindMyLocationItem[]> => {
    // Check the keys first: without them, bouncing Find My cannot produce anything we can read
    const localStorageKey = backend.loadLocalStorageKey();
    if (!localStorageKey) {
        backend.log("Find My LocalStorage key is not imported; cannot read friend locations.");
        return backend.cache.getAll();
    }
    const fmfKey = await backend.loadFmfKey();
    if (!fmfKey) {
        backend.log("Find My FMF key is not imported; cannot read the friend list.");
        return backend.cache.getAll();
    }

    const readCurrent = (): FindMyLocationItem[] => {
        const roster = buildFindMyRoster(backend.readRosterData(fmfKey));
        if (!roster) throw new Error("Find My friend list has no `following` array");
        backend.cache.setRoster(roster);
        return buildEncryptedFriendItems(backend.readLocations(localStorageKey), roster);
    };

    if (openFindMyApp) {
        // Quit afterwards only if Find My was not already open: the server owner may be using it
        const wasRunning = await backend.isFindMyRunning();
        startBackgroundFindMyRefresh(
            backend.bounce,
            readCurrent,
            backend.publish,
            error => backend.log(`Failed to refresh Find My friends from the encrypted cache: ${error}`),
            wasRunning ? undefined : backend.quitFindMy
        );
    }

    try {
        backend.cache.addAll(await backend.label(readCurrent()));
    } catch (error) {
        // A transient read or decrypt failure keeps serving the last good cache
        backend.log(`Failed to read Find My friends from the encrypted cache: ${error}`);
    }
    return backend.cache.getAll();
};
