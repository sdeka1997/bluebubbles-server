import { ContactInterface } from "@server/api/interfaces/contactInterface";

import { buildAddressToContactMap } from "./chatMergeKey";

/**
 * Caches the address-to-contact-card map used to build chat merge keys.
 *
 * Loading Contacts is far too slow to do per chat: a chat list request
 * serializes hundreds of chats, and the map is identical for all of them.
 * The map is built once and reused until it expires or is invalidated.
 *
 * A stale map is not harmful. An address added to Contacts after the map was
 * built simply fails to resolve, which leaves the chat unkeyed and folded the
 * way it is today — never merged with the wrong conversation.
 */
const CACHE_TTL_MS = 5 * 60 * 1000;

let cachedMap: Map<string, string> | null = null;
let cachedAt = 0;
let inFlight: Promise<Map<string, string>> | null = null;

/** Drops the cached map. Call after Contacts change. */
export function invalidateMergeKeyContacts(): void {
    cachedMap = null;
    cachedAt = 0;
}

/**
 * The address-to-card map, loading Contacts only when the cache is cold.
 *
 * Concurrent callers share one load: a chat list request serializes its chats
 * with `Promise.all`, so without this they would each start their own.
 * Returns an empty map if Contacts cannot be read, which leaves every chat
 * unkeyed rather than failing the request.
 */
export async function getMergeKeyContactMap(): Promise<Map<string, string>> {
    if (cachedMap != null && Date.now() - cachedAt < CACHE_TTL_MS) return cachedMap;
    if (inFlight != null) return inFlight;

    inFlight = (async () => {
        try {
            const contacts = await ContactInterface.getAllContacts();
            const map = buildAddressToContactMap(contacts);
            cachedMap = map;
            cachedAt = Date.now();
            return map;
        } catch (ex: any) {
            // Contacts permission can be missing or revoked. Chats then keep
            // their current grouping instead of the request failing.
            return new Map<string, string>();
        } finally {
            inFlight = null;
        }
    })();

    return inFlight;
}
