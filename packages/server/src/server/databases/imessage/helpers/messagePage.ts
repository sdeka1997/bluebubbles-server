import type { DBWhereItem } from "../types";

type Direction = "ASC" | "DESC";

/**
 * ORDER BY terms for a page of messages. Dates tie (a message and its
 * reactions often share one), so ROWID breaks ties, in the same direction as
 * the date: SQLite can only walk `message_idx_date` for the page when every
 * term runs the same way. Left to TypeORM, the tiebreak is `ROWID ASC` on a
 * newest-first page, which makes SQLite join and sort every message in
 * chat.db before taking the first 200.
 */
export function messagePageOrder(orderBy: string, sort: string | null | undefined): Array<[string, Direction]> {
    const direction: Direction = String(sort).toUpperCase() === "ASC" ? "ASC" : "DESC";
    if (orderBy === "message.ROWID") return [[orderBy, direction]];
    return [
        [orderBy, direction],
        ["message.ROWID", direction]
    ];
}

/**
 * Whether any WHERE statement reads columns of the join [alias], e.g.
 * `handle.id` for "handle", but not `chandle.id` or `message.handle_id`.
 */
export function whereUsesAlias(where: DBWhereItem[] | null | undefined, alias: string): boolean {
    const pattern = new RegExp(`(?<![\\w."])"?${alias}"?\\.`);
    return (where ?? []).some(item => pattern.test(item?.statement ?? ""));
}

/**
 * The total a page already proves: a page shorter than [limit] holds every
 * remaining result, so the total is [offset] plus its size. An empty page past
 * the start proves nothing (the offset may be past the end), nor does a full
 * one; those return null and need a COUNT.
 */
export function totalFromPage(offset: number | null | undefined, limit: number | null | undefined, count: number): number | null {
    if (limit == null || count >= limit) return null;
    const start = offset ?? 0;
    if (count === 0 && start > 0) return null;
    return start + count;
}
