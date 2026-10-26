import fs from "fs";
import path from "path";
import { startBackgroundFindMyRefresh } from "./BackgroundFindMyRefresh";
import { decryptCacheBuffer } from "./decrypt/cache";
import { readCacheFile } from "./decrypt/plistUtils";
import { buildEncryptedFriendItems, EncryptedFriendLocation } from "./EncryptedFriendMapper";
import { buildFindMyRoster } from "./FindMyFriendRoster";
import { FindMyFriendsCache } from "./FindMyFriendsCache";
import { FindMyDevice, FindMyItem, FindMyLocationItem } from "./types";
import { transformFindMyItemToDevice } from "./utils";

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

/**
 * Devices for macOS 14.4+: decrypts the FMIP caches (Devices, Items, ItemGroups) in `findMyDir`
 * and combines them as the plaintext path does. A file that is missing, corrupt or sealed with
 * another key counts as absent, so one bad file cannot hide the rest.
 *
 * @returns null if neither Devices nor Items could be read
 */
export const readEncryptedDevices = (
    fmipKey: Buffer,
    findMyDir: string,
    onError: (file: string, error: unknown) => void = () => undefined
): FindMyDevice[] | null => {
    const read = (name: string): any[] | null => {
        const file = `${name}.data`;
        const filePath = path.join(findMyDir, file);
        if (!fs.existsSync(filePath)) return null;
        try {
            const data = decryptCacheBuffer(readCacheFile(filePath), fmipKey);
            // Apple's "$null" entries are normalized to null; skip them
            return Array.isArray(data) ? data.filter(record => record && typeof record === "object") : [];
        } catch (error) {
            onError(file, error);
            return null;
        }
    };

    const devices: FindMyDevice[] | null = read("Devices");
    const items: FindMyItem[] | null = read("Items");
    if (devices == null && items == null) return null;

    const groupNames = new Map<string, string>((read("ItemGroups") ?? []).map(group => [group.identifier, group.name]));
    for (const item of items ?? []) {
        if (item.groupIdentifier && groupNames.has(item.groupIdentifier)) {
            item.groupName = groupNames.get(item.groupIdentifier);
        }
    }

    return [...(devices ?? []), ...(items ?? []).map(transformFindMyItemToDevice)];
};
