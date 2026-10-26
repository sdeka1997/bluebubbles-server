import assert from "node:assert/strict";
import test from "node:test";

import { FindMyAddressLabeler } from "../src/server/api/lib/findmy/AppleReverseGeocoder";
import { buildEncryptedFriendItems } from "../src/server/api/lib/findmy/EncryptedFriendMapper";
import { buildFindMyRoster } from "../src/server/api/lib/findmy/FindMyFriendRoster";
import { FindMyFriendsCache } from "../src/server/api/lib/findmy/FindMyFriendsCache";

// Same shape as the decrypted FMF cache: ids padded with "~", as PR #810 found them.
const roster = buildFindMyRoster({
    myInfo: { emails: ["owner@example.com"] },
    contacts: { "person-dad~": { displayName: "Dad" } },
    following: [
        {
            id: "person-dad~",
            invitationAcceptedHandles: ["dad-current@example.com"],
            invitationFromHandles: ["owner@example.com"]
        }
    ],
    followers: [
        {
            id: "person-dad~",
            invitationAcceptedHandles: ["owner@example.com"],
            invitationFromHandles: ["dad-old@example.edu"]
        }
    ]
})!;

const UPDATED = new Date("2026-10-26T12:00:00Z");

// The decrypted `secureLocations.value` plist from LocalStorage.db, per PR #810.
const row = (location: Record<string, any> = {}, findMyId = "person-dad~") => ({
    findMyId,
    location: { latitude: 33.0198, longitude: -96.6989, timestamp: UPDATED, ...location }
});

test("maps a roster friend's location to the client payload under their primary handle", () => {
    assert.deepEqual(buildEncryptedFriendItems([row()], roster), [
        {
            handle: "dad-current@example.com",
            coordinates: [33.0198, -96.6989],
            long_address: "33.020° N, 96.699° W",
            short_address: "33.020° N, 96.699° W",
            subtitle: null,
            title: "Dad",
            last_updated: UPDATED.getTime(),
            is_locating_in_progress: false,
            status: "shallow"
        }
    ]);
});

test("skips a location the roster cannot match instead of publishing Apple's opaque id", () => {
    const items = buildEncryptedFriendItems([row({}, "stranger~~"), row({}, ""), row()], roster);

    assert.deepEqual(items.map(item => item.handle), ["dad-current@example.com"]);
});

test("skips rows without a real fix: missing, non-finite, out-of-range, or [0, 0] coordinates", () => {
    const invalid = [
        { latitude: 0, longitude: 0 },
        { latitude: undefined },
        { latitude: "33.0198" },
        { latitude: Number.NaN },
        { longitude: Number.POSITIVE_INFINITY },
        { latitude: 90.5 },
        { longitude: -180.5 }
    ];

    assert.deepEqual(buildEncryptedFriendItems(invalid.map(location => row(location)), roster), []);
    assert.equal(buildEncryptedFriendItems([row({ latitude: 0, longitude: 179.9 })], roster).length, 1);
});

test("normalizes plist dates, epoch seconds, and epoch milliseconds to epoch milliseconds", () => {
    const ms = UPDATED.getTime();
    const items = buildEncryptedFriendItems(
        [row({ timestamp: UPDATED }), row({ timestamp: ms / 1000 }), row({ timestamp: ms }), row({ timestamp: 1793016000.5 })],
        roster
    );

    assert.deepEqual(items.map(item => item.last_updated), [ms, ms, ms, ms + 500]);
});

test("skips rows whose timestamp is missing or unusable", () => {
    const invalid = [undefined, null, "2026-10-26", Number.NaN, 0, -5, new Date(Number.NaN)];

    assert.deepEqual(buildEncryptedFriendItems(invalid.map(timestamp => row({ timestamp })), roster), []);
});

test("keeps Apple's own labels such as Home and Work and never geocodes over them", async () => {
    const items = buildEncryptedFriendItems(
        [row({ locationLabel: "Home" }), row({ locationLabel: " Work ", latitude: 32.7767 })],
        roster
    );
    assert.deepEqual(
        items.map(item => [item.short_address, item.long_address]),
        [
            ["Home", "Home"],
            ["Work", "Work"]
        ]
    );

    const geocoded: Array<[number, number]> = [];
    await new FindMyAddressLabeler(async coordinates => {
        geocoded.push(...coordinates);
        return coordinates.map(() => ({ short: "Plano, TX", long: "1 Main St" }));
    }).label(items);
    assert.deepEqual(geocoded, []);
});

test("treats a \"$null\", null, blank, or non-text label as absent so the geocoder fills the address", async () => {
    const labels = ["$null", null, "  ", 42];
    const items = buildEncryptedFriendItems(
        labels.map((locationLabel, i) => row({ locationLabel, latitude: 33 + i })),
        roster
    );

    const geocoded: Array<[number, number]> = [];
    const labeled = await new FindMyAddressLabeler(async coordinates => {
        geocoded.push(...coordinates);
        return coordinates.map(() => ({ short: "Plano, TX", long: "1 Main St" }));
    }).label(items);

    assert.equal(geocoded.length, labels.length);
    assert.deepEqual(
        labeled.map(item => [item.short_address, item.long_address]),
        labels.map(() => ["Plano, TX", "1 Main St"])
    );
});

test("mapped items replace the cache's no-location placeholder and gain the favorite order", () => {
    const favoriteRoster = buildFindMyRoster({
        following: [{ id: "person-dad~", invitationAcceptedHandles: ["dad-current@example.com"] }],
        preferences: { favorites: [{ id: "person-dad~", order: 0 }] }
    })!;
    const cache = new FindMyFriendsCache();
    cache.setRoster(favoriteRoster);
    assert.equal(cache.hasAnyLocation(), false);

    const emitted = cache.addAll(buildEncryptedFriendItems([row()], favoriteRoster));

    assert.equal(cache.hasAnyLocation(), true);
    assert.deepEqual(emitted, cache.getAll());
    assert.deepEqual(Object.keys(emitted[0]).sort(), [
        "coordinates",
        "favorite_order",
        "handle",
        "is_locating_in_progress",
        "last_updated",
        "long_address",
        "short_address",
        "status",
        "subtitle",
        "title"
    ]);
    assert.equal(emitted[0].favorite_order, 0);
    assert.equal(JSON.stringify(emitted).includes("person-dad"), false);
});

test("skips a row whose decrypted plist is not a dictionary instead of failing the batch", () => {
    const malformed = [null, "bplist", [33, -96]].map(location => ({ findMyId: "person-dad~", location }) as any);

    assert.deepEqual(buildEncryptedFriendItems([...malformed, row()], roster).map(item => item.handle), [
        "dad-current@example.com"
    ]);
});
