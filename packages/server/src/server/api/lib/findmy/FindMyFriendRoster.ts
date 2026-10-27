import fs from "fs";

export type FindMyRoster = {
    /** Normalized phone/email -> Apple's opaque friend id. */
    aliases: Map<string, string>;
    /** Apple friend id -> the handle clients identify the friend by. */
    primaryHandles: Map<string, string>;
    /** Apple friend id -> contact name Find My shows for the friend. */
    names: Map<string, string>;
    /** Apple friend id -> position in the user's Find My favorites. */
    favorites: Map<string, number>;
};

/** Apple writes one number in several display formats, so compare phones by digits. */
export const normalizeFindMyHandle = (handle: string): string => {
    const value = handle.trim().toLowerCase();
    if (value.includes("@")) return value;
    const digits = value.replace(/\D/g, "");
    return digits.length > 0 ? `tel:${digits}` : value;
};

/**
 * Apple pads friend ids with trailing "~" in the encrypted (macOS 14.4+) caches.
 * Strip it so every source agrees on one id per friend.
 */
export const stripFindMyIdPadding = (id: string): string => id.replace(/~+$/, "");

const friendId = (value: unknown): string | null => {
    if (typeof value !== "string") return null;
    const id = stripFindMyIdPadding(value);
    return id.length > 0 ? id : null;
};

// Apple's plists store a literal "$null" where the plaintext JSON had null.
const isText = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0 && value !== "$null";

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter(isText) : []);

/**
 * Builds the one-person-per-row roster used by Apple's Find My UI.
 *
 * A share is recorded in both directions. The friend's handles are the ones they
 * accepted my invitation on (`following`) and the ones they invited me from
 * (`followers`). The opposite fields hold my handles and must not become aliases.
 */
export const buildFindMyRoster = (data: any): FindMyRoster | null => {
    const following: any[] | null = Array.isArray(data?.following) ? data.following : null;
    if (!following) return null;
    const followers: any[] = Array.isArray(data?.followers) ? data.followers : [];

    const ownHandles = new Set(
        [
            ...strings(data?.myInfo?.emails),
            ...following.flatMap(friend => strings(friend?.invitationFromHandles)),
            ...followers.flatMap(friend => strings(friend?.invitationAcceptedHandles))
        ].map(normalizeFindMyHandle)
    );

    const handlesById = new Map<string, string[]>();
    for (const friend of following) {
        const id = friendId(friend?.id);
        if (!id) continue;
        const accepted = strings(friend.invitationAcceptedHandles);
        const fallback = strings([friend.invitationFromHandle, friend.invitationSentToHandle]);
        handlesById.set(id, accepted.length > 0 ? accepted : fallback);
    }
    for (const friend of followers) {
        const id = friendId(friend?.id);
        const handles = id ? handlesById.get(id) : undefined;
        if (handles) handles.push(...strings(friend.invitationFromHandles));
    }

    const aliases = new Map<string, string>();
    const ambiguous = new Set<string>();
    const primaryHandles = new Map<string, string>();
    for (const [id, handles] of handlesById) {
        const friendHandles = handles.filter(handle => !ownHandles.has(normalizeFindMyHandle(handle)));
        if (friendHandles.length === 0) continue;
        primaryHandles.set(id, friendHandles[0]);
        for (const handle of friendHandles) {
            const key = normalizeFindMyHandle(handle);
            const existing = aliases.get(key);
            if (existing && existing !== id) ambiguous.add(key);
            aliases.set(key, id);
        }
    }
    for (const key of ambiguous) aliases.delete(key);

    const names = new Map<string, string>();
    const contacts: Record<string, any> = {};
    if (data?.contacts && typeof data.contacts === "object") {
        for (const [rawId, contact] of Object.entries(data.contacts)) {
            const id = friendId(rawId);
            if (id) contacts[id] = contact;
        }
    }
    for (const id of primaryHandles.keys()) {
        const name = [contacts[id]?.displayName, contacts[id]?.shortName].find(isText);
        if (name) names.set(id, name);
    }

    const favorites = new Map<string, number>();
    for (const favorite of Array.isArray(data?.preferences?.favorites) ? data.preferences.favorites : []) {
        const id = friendId(favorite?.id);
        if (id && Number.isFinite(favorite?.order) && primaryHandles.has(id)) favorites.set(id, favorite.order);
    }

    return { aliases, primaryHandles, names, favorites };
};

/** Returns null if Apple's roster file is absent or temporarily unreadable. */
export const readFindMyRoster = (friendsPath: string): FindMyRoster | null => {
    try {
        return buildFindMyRoster(JSON.parse(fs.readFileSync(friendsPath, "utf8")));
    } catch {
        return null;
    }
};
