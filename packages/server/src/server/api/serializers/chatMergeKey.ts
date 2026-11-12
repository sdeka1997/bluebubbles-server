/**
 * Apple's chat merge key, reconstructed from Contacts.
 *
 * Messages groups several `chat` rows into one conversation using IMCore's
 * `personCentricID`. That value has two segments: a group-id prefix, which
 * DIFFERS between merged rows, and a chain of Contacts card UUIDs, which is
 * identical for them:
 *
 *   row 35    515CF6DA-...-4C5136A9...:ABPersonCFBEB9C6...:ABPersonF5478A69...:ABPerson
 *   row 2430  3833383845...-4C5136A9...:ABPersonCFBEB9C6...:ABPersonF5478A69...:ABPerson
 *                           ^--------------- identical ---------------^
 *
 * So the merge is by contact card identity, not by group id. That is why Messages
 * merges a group whose membership changed by one person, and why it merges a 1:1
 * conversation held with the same person's email and phone number.
 *
 * IMCore computes this at runtime; `handle.person_centric_id` is NULL for every
 * handle in chat.db, so it cannot be read back from the database. The Contacts
 * API exposes the same `UUID:ABPerson` identifiers Apple embeds, so we rebuild the
 * chain ourselves. Checked against IMCore's live answer for 201 chats: 94 agreed,
 * 0 disagreed, and the rest were chats Apple itself had not resolved to contacts.
 */

/** A contact as returned by ContactInterface: an id plus its addresses. */
export type MergeKeyContact = {
    id?: string | null;
    phoneNumbers?: { address?: string | null }[] | null;
    emails?: { address?: string | null }[] | null;
    emailAddresses?: { address?: string | null }[] | null;
};

/**
 * Normalizes an address so a handle can be matched to a contact's addresses.
 * Emails are compared case-insensitively; phone numbers are compared by their
 * last 10 digits, which ignores formatting and the US country code.
 *
 * Deliberately stricter than ContactInterface.findContact, which also accepts
 * matches on the last 7 digits. Here a wrong match merges two conversations, so
 * only an unambiguous match is useful.
 */
export function normalizeAddress(address: string | null | undefined): string | null {
    if (typeof address !== "string") return null;
    const trimmed = address.trim().toLowerCase();
    if (trimmed.length === 0) return null;
    if (trimmed.includes("@")) return trimmed;

    const digits = trimmed.replace(/\D/g, "");
    if (digits.length === 0) return null;
    // Short codes (e.g. 85893) have no country code to strip.
    if (digits.length < 10) return digits;
    const national = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
    return national.slice(-10);
}

/**
 * Maps each normalized address to the contact card that owns it. An address
 * claimed by more than one card is dropped: it cannot identify a person, and
 * guessing would merge unrelated conversations.
 */
export function buildAddressToContactMap(contacts: MergeKeyContact[] | null | undefined): Map<string, string> {
    const claims = new Map<string, Set<string>>();
    for (const contact of contacts ?? []) {
        const id = contact?.id;
        if (typeof id !== "string" || id.length === 0) continue;

        const addresses = [...(contact.phoneNumbers ?? []), ...(contact.emails ?? []), ...(contact.emailAddresses ?? [])];
        for (const entry of addresses) {
            const key = normalizeAddress(entry?.address);
            if (key == null) continue;
            if (!claims.has(key)) claims.set(key, new Set());
            claims.get(key)!.add(id);
        }
    }

    const resolved = new Map<string, string>();
    for (const [address, ids] of claims) {
        if (ids.size === 1) resolved.set(address, [...ids][0]);
    }
    return resolved;
}

/**
 * The merge key for a chat with these participant addresses, or null when the
 * chat cannot be keyed.
 *
 * Returns null unless EVERY participant resolves to a contact card. A partially
 * resolved chat would key on a subset of its members and could merge with a
 * different conversation, so such chats are left alone — the caller falls back to
 * today's group-id behaviour. Duplicate cards are collapsed, so a 1:1 chat with
 * someone's email and another with their phone number produce the same key.
 */
export function chatMergeKey(
    participantAddresses: (string | null | undefined)[] | null | undefined,
    addressToContact: Map<string, string>
): string | null {
    if (!Array.isArray(participantAddresses) || participantAddresses.length === 0) return null;

    const cards = new Set<string>();
    for (const address of participantAddresses) {
        const key = normalizeAddress(address);
        if (key == null) return null;
        const card = addressToContact.get(key);
        if (card == null) return null;
        cards.add(card);
    }

    if (cards.size === 0) return null;
    return [...cards].sort().join("");
}
