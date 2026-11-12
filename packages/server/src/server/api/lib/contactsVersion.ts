/**
 * Names the current state of the contact photos without loading any of them, so a
 * client can skip re-downloading every photo when none can have changed. It
 * changes when the server starts, when macOS reports a change to Contacts, and
 * when the server's own contact rows change (their count or latest update).
 */
export class ContactsVersion {
    private changes = 0;

    constructor(private readonly startedAt: number = Date.now()) {}

    markChanged(): void {
        this.changes++;
    }

    of(db: { count: number; lastUpdated: string | number | null }): string {
        return [this.startedAt, this.changes, db.count, db.lastUpdated ?? ""].join(".");
    }
}
