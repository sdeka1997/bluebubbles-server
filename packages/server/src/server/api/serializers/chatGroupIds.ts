import { latestGroupTitles, QueryRunner } from "../../databases/imessage/helpers/latestGroupTitles";
import { isChatFilteredAsSpam } from "./chatSpam";

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

/** What the client needs to put every copy of a conversation in one thread. */
export type ChatGroupingFields = {
    originalGroupId: string | null;
    legacyGroupIds: string[];
    // Name after the newest rename; "" when it was cleared, null if never renamed.
    latestGroupTitle: string | null;
};

const CHUNK = 500;

type GroupingChat = { ROWID: number; style?: number; properties: NodeJS.Dict<any>[] | null };

// chat.style of a one-to-one chat; groups are 43.
const ONE_TO_ONE_STYLE = 45;

async function originalGroupIds(run: QueryRunner, chatIds: number[]): Promise<Map<number, string | null>> {
    const ids = new Map<number, string | null>();
    for (let i = 0; i < chatIds.length; i += CHUNK) {
        const part = chatIds.slice(i, i + CHUNK);
        const rows = await run(
            `SELECT ROWID, original_group_id FROM chat WHERE ROWID IN (${part.map(() => "?").join(", ")});`,
            part
        );
        for (const row of rows) ids.set(Number(row.ROWID), row.original_group_id ?? null);
    }
    return ids;
}

/**
 * Grouping fields for [chats], keyed by ROWID. Each lookup fails soft: older
 * Macs lack `original_group_id`, and a locked database must not stop a chat
 * from being sent.
 */
export async function groupingFields(run: QueryRunner, chats: GroupingChat[]): Promise<Map<number, ChatGroupingFields>> {
    const fields = new Map<number, ChatGroupingFields>();
    if (chats.length === 0) return fields;
    const ids = chats.map(c => c.ROWID);
    // Only groups can be renamed, and searching a long one-to-one chat for a
    // rename that cannot be there is most of the cost of this lookup.
    const groupIds = chats.filter(c => c.style !== ONE_TO_ONE_STYLE).map(c => c.ROWID);
    const originals = await originalGroupIds(run, ids).catch((): Map<number, string | null> => new Map());
    const titles = await latestGroupTitles(run, groupIds).catch((): Map<number, string> => new Map());
    for (const chat of chats) {
        fields.set(chat.ROWID, {
            originalGroupId: originals.get(chat.ROWID) ?? null,
            legacyGroupIds: legacyGroupIds(chat.properties),
            latestGroupTitle: titles.has(chat.ROWID) ? titles.get(chat.ROWID) : null
        });
    }
    return fields;
}

/** Everything the client groups and spam-files a chat by, and nothing else. */
export type ChatGroupingRow = ChatGroupingFields & {
    guid: string;
    groupId: string | null;
    isFilteredAsSpam: boolean;
};

/**
 * [ChatGroupingRow]s for a page of [chats]: the same values a whole serialized
 * chat carries, without its participants and the rest. The client checks every
 * chat's grouping and spam state on each launch, and whole chats made that
 * download four times larger.
 */
export async function groupingRows(
    run: QueryRunner,
    chats: Array<GroupingChat & { guid: string; groupId?: string | null }>
): Promise<ChatGroupingRow[]> {
    const fields = await groupingFields(run, chats);
    return chats.map(chat => ({
        guid: chat.guid,
        groupId: chat.groupId ?? null,
        isFilteredAsSpam: isChatFilteredAsSpam(chat.properties),
        ...fields.get(chat.ROWID)
    }));
}

/**
 * Grouping fields for every chat of a page of [messages], from one lookup.
 * Serializing each message's chats on their own ran it once per message.
 */
export async function groupingFieldsForMessages(
    run: QueryRunner,
    messages: Array<{ chats?: GroupingChat[] } | null>
): Promise<Map<number, ChatGroupingFields>> {
    const chats = new Map<number, GroupingChat>();
    for (const message of messages) {
        for (const chat of message?.chats ?? []) {
            if (chat?.ROWID != null && !chats.has(chat.ROWID)) chats.set(chat.ROWID, chat);
        }
    }
    return groupingFields(run, [...chats.values()]);
}
