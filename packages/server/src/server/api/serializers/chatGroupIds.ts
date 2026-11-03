/**
 * Old group ids Messages keeps for a chat, from the chat's decoded `properties`
 * plist (`LegacyGroupIdentifiers`). Messages adds a group's previous ids here
 * when it is renamed or its members change, so the client can keep every copy
 * of one conversation in one thread. Sequoia has no `chat_lookup` table; this
 * is where it keeps the same links.
 */
export function legacyGroupIds(properties: NodeJS.Dict<any>[] | null | undefined): string[] {
    if (!Array.isArray(properties)) return [];
    const ids = new Set<string>();
    for (const props of properties) {
        if (props == null || typeof props !== "object") continue;
        const list = props.LegacyGroupIdentifiers;
        if (!Array.isArray(list)) continue;
        for (const id of list) {
            if (typeof id === "string" && id.trim() !== "") ids.add(id);
        }
    }
    return [...ids];
}
