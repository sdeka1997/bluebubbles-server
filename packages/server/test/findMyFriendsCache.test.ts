import assert from "node:assert/strict";
import test from "node:test";

import { FindMyFriendsCache } from "../src/server/api/lib/findmy/FindMyFriendsCache";
import { FindMyLocationItem } from "../src/server/api/lib/findmy/types";
import { buildFindMyRoster, FindMyRoster } from "../src/server/api/lib/findmy/FindMyFriendRoster";

const location = (handle: string, overrides: Partial<FindMyLocationItem> = {}): FindMyLocationItem => ({
    handle,
    coordinates: [33.0198, -96.6989],
    long_address: "Plano, TX",
    short_address: "Plano, TX",
    subtitle: null,
    title: "Synthetic Friend",
    last_updated: 1,
    is_locating_in_progress: false,
    status: "shallow",
    ...overrides
});

test("direct-reader aliases reuse an existing Messages handle in emitted updates", () => {
    const cache = new FindMyFriendsCache();
    cache.add(location("friend@example.com", { status: "legacy" }));

    const added = cache.addAll([
        location("+15550123", {
            alternate_handles: ["friend@example.com"],
            last_updated: 2
        })
    ]);

    assert.equal(cache.getAll().length, 1);
    assert.equal(added.length, 1);
    assert.equal(added[0].handle, "friend@example.com");
    assert.equal(added[0].alternate_handles, undefined);
});

test("accepted phone and email aliases resolve to one cached friend", () => {
    const cache = new FindMyFriendsCache();
    const phone = "+15550123";

    const added = cache.addAll([location(phone, { alternate_handles: ["friend@example.com"] })]);
    assert.equal(added[0].alternate_handles, undefined);
    const updated = cache.addAll([location("friend@example.com", { last_updated: 2 })]);

    const friends = cache.getAll();
    assert.equal(friends.length, 1);
    assert.equal(friends[0].handle, phone);
    assert.equal(friends[0].alternate_handles, undefined);
    assert.equal(updated.length, 1);
    assert.equal(updated[0].handle, phone);
    assert.equal(updated[0].alternate_handles, undefined);
});


const rosterFor = (ids: string[]): FindMyRoster =>
    buildFindMyRoster({
        myInfo: { emails: ["owner@example.com"] },
        contacts: Object.fromEntries(ids.map(id => [id, { displayName: id === "friend-1" ? "Current Name" : id }])),
        following: ids.map(id => ({
            id,
            invitationAcceptedHandles: [id === "friend-1" ? "current@example.com" : `${id}@example.com`],
            invitationFromHandles: ["owner@example.com"]
        })),
        followers: ids.map(id => ({
            id,
            invitationAcceptedHandles: ["owner@example.com"],
            invitationFromHandles: [id === "friend-1" ? "old@example.edu" : `${id}@example.com`]
        })),
        preferences: { favorites: [{ id: "friend-1", order: 0 }] }
    })!;

test("authoritative roster collapses old and current handles to one friend", () => {
    const cache = new FindMyFriendsCache(() => rosterFor(["friend-1"]));
    cache.refreshRoster(true);

    cache.add(location("old@example.edu", { title: "Old label", last_updated: 1, status: "legacy" }));
    cache.add(location("current@example.com", { title: "Incoming label", last_updated: 2 }));

    assert.deepEqual(cache.getAll(), [
        {
            ...location("current@example.com", { title: "Current Name", last_updated: 2 }),
            favorite_order: 0
        }
    ]);
    assert.equal(cache.get("old@example.edu")?.handle, "current@example.com");
});

test("authoritative roster rejects updates for people Apple no longer lists", () => {
    const cache = new FindMyFriendsCache(() => rosterFor(["friend-1"]));
    cache.refreshRoster(true);

    assert.deepEqual(cache.addAll([location("removed@example.com")]), []);
    assert.equal(cache.get("removed@example.com"), null);
    assert.deepEqual(cache.getAll().map(item => item.handle), ["current@example.com"]);
});

test("refreshing the authoritative roster removes people who stopped sharing", () => {
    let roster = rosterFor(["friend-1", "friend-2"]);
    const cache = new FindMyFriendsCache(() => roster);
    cache.refreshRoster(true);
    cache.add(location("current@example.com"));
    cache.add(location("friend-2@example.com"));
    assert.equal(cache.getAll().length, 2);

    roster = rosterFor(["friend-1"]);
    cache.refreshRoster(true);

    assert.equal(cache.getAll().length, 1);
    assert.equal(cache.getAll()[0].handle, "current@example.com");
});


test("authoritative roster keeps friends who currently have no location", () => {
    const cache = new FindMyFriendsCache(() => rosterFor(["friend-1", "friend-2"]));
    cache.refreshRoster(true);
    cache.add(location("current@example.com", { last_updated: 2 }));

    const missing = cache.getAll().find(item => item.handle === "friend-2@example.com");
    assert.equal(cache.getAll().length, 2);
    assert.deepEqual(missing?.coordinates, [0, 0]);
    assert.equal(missing?.status, "legacy");
    assert.equal(missing?.title, "friend-2");
});

test("setRoster keeps current locations of friends still on the roster", () => {
    const cache = new FindMyFriendsCache(() => rosterFor(["friend-1"]));
    cache.refreshRoster(true);
    cache.add(location("current@example.com", { last_updated: 5 }));

    cache.setRoster(rosterFor(["friend-1", "friend-2"]));

    const kept = cache.get("old@example.edu");
    assert.deepEqual(kept, {
        ...location("current@example.com", { title: "Current Name", last_updated: 5 }),
        favorite_order: 0
    });
});

test("setRoster removes friends who stopped sharing", () => {
    const cache = new FindMyFriendsCache();
    cache.setRoster(rosterFor(["friend-1", "friend-2"]));
    cache.add(location("current@example.com"));
    cache.add(location("friend-2@example.com"));

    cache.setRoster(rosterFor(["friend-1"]));

    assert.deepEqual(cache.getAll().map(item => item.handle), ["current@example.com"]);
    assert.equal(cache.get("friend-2@example.com"), null);
});

test("setRoster lists roster friends without a location as placeholders", () => {
    const cache = new FindMyFriendsCache();
    cache.setRoster(rosterFor(["friend-1", "friend-2"]));

    assert.deepEqual(cache.get("friend-2@example.com"), {
        handle: "friend-2@example.com",
        coordinates: [0, 0],
        long_address: null,
        short_address: null,
        subtitle: null,
        title: "friend-2",
        last_updated: 0,
        is_locating_in_progress: false,
        status: "legacy"
    });
    assert.equal(cache.hasAnyLocation(), false);
});

test("an encrypted-path primary handle merges with a row cached under an old alias", () => {
    const cache = new FindMyFriendsCache();
    cache.setRoster(rosterFor(["friend-1"]));
    cache.add(location("old@example.edu", { status: "legacy", last_updated: 1 }));

    const emitted = cache.addAll([location("current@example.com", { last_updated: 2 })]);

    assert.equal(cache.getAll().length, 1);
    assert.equal(emitted[0].handle, "current@example.com");
    assert.equal(emitted[0].alternate_handles, undefined);
    assert.equal(cache.get("old@example.edu")?.last_updated, 2);
});

test("legacy refreshRoster still reloads at most every 30 s unless forced", () => {
    let loads = 0;
    const cache = new FindMyFriendsCache(() => {
        loads += 1;
        return rosterFor(["friend-1"]);
    });
    cache.refreshRoster(false, 1000);
    cache.refreshRoster(false, 2000);
    cache.refreshRoster(true, 3000);
    cache.refreshRoster(false, 40000);

    assert.equal(loads, 3);
});

test("legacy refreshRoster keeps the previous roster when Apple's file is unreadable", () => {
    let roster: FindMyRoster | null = rosterFor(["friend-1"]);
    const cache = new FindMyFriendsCache(() => roster);
    cache.refreshRoster(true);
    cache.add(location("current@example.com", { last_updated: 3 }));

    roster = null;
    cache.refreshRoster(true);

    assert.equal(cache.get("old@example.edu")?.last_updated, 3);
    assert.deepEqual(cache.addAll([location("stranger@example.com")]), []);
});
