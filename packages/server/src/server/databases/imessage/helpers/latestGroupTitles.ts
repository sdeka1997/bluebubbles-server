/** Runs one read-only SQL query against chat.db and returns its rows. */
export type QueryRunner = (sql: string, params: any[]) => Promise<any[]>;

// Older SQLite builds cap a statement at 999 bound parameters.
const CHUNK = 500;

/**
 * The name each chat has after its newest rename, keyed by chat ROWID.
 * `chat.display_name` can lag behind a rename (seen on Sequoia after names were
 * cleared on the iPhone); the rename itself is a message with `item_type` 2
 * whose `group_title` is the new name, or null when the name was cleared.
 * A cleared name is returned as "". Chats never renamed have no entry.
 */
export async function latestGroupTitles(run: QueryRunner, chatIds: number[]): Promise<Map<number, string>> {
    const titles = new Map<number, string>();
    for (let i = 0; i < chatIds.length; i += CHUNK) {
        const ids = chatIds.slice(i, i + CHUNK);
        const rows = await run(
            `SELECT cmj.chat_id AS chat_id, m.group_title AS group_title
            FROM chat_message_join AS cmj
            JOIN message AS m ON m.ROWID = cmj.message_id
            WHERE m.item_type = 2 AND cmj.chat_id IN (${ids.map(() => "?").join(", ")})
            ORDER BY cmj.chat_id, m.date DESC, m.ROWID DESC;`,
            ids
        );
        for (const row of rows) {
            const id = Number(row.chat_id);
            if (!titles.has(id)) titles.set(id, row.group_title ?? "");
        }
    }
    return titles;
}
