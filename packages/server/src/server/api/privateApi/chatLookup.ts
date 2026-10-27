/**
 * Optional hints the helper uses to find a chat when this Mac doesn't know its GUID
 * (e.g. after a new Mac or a chat.db reset): the Messages group ID, then, for 1:1 chats,
 * the participant's address on the given service.
 */
export type ChatLookup = {
    groupId?: string | null;
    participants?: string[] | string | null;
    service?: string | null;
};

const isFilledString = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/**
 * Adds any valid lookup hints to a helper payload. Without hints the payload is returned unchanged.
 */
export const withChatLookup = <T extends Record<string, any>>(data: T, lookup?: ChatLookup | null): T => {
    const result: Record<string, any> = { ...data };
    if (isFilledString(lookup?.groupId)) result.groupId = lookup.groupId;

    // Form data sends a single participant as a plain string
    const participants = (Array.isArray(lookup?.participants) ? lookup.participants : [lookup?.participants]).filter(
        isFilledString
    );
    if (participants.length > 0) result.participants = participants;

    if (isFilledString(lookup?.service)) result.service = lookup.service;
    return result as T;
};
