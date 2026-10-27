import assert from "node:assert/strict";
import test from "node:test";

import {
    EncryptedFriendsBackend,
    refreshEncryptedFriends,
    selectFindMyBackend
} from "../src/server/api/lib/findmy/FindMyEncryptedBackend";
import { FindMyFriendsCache } from "../src/server/api/lib/findmy/FindMyFriendsCache";
import { FindMyLocationItem } from "../src/server/api/lib/findmy/types";

const LOCAL_STORAGE_KEY = Buffer.alloc(32, 0xa1);
const FMF_KEY = Buffer.alloc(32, 0xc3);

// Decrypted FriendCacheData: two friends, only one of whom has a location
const ROSTER_DATA = {
    following: [
        { id: "friend-1~", invitationAcceptedHandles: ["dad@example.com"] },
        { id: "friend-2~", invitationAcceptedHandles: ["+15551234567"] }
    ],
    contacts: { "friend-1~": { displayName: "Dad" }, "friend-2~": { displayName: "Mom" } }
};

const fix = (latitude: number, longitude: number, seconds: number) => ({
    findMyId: "friend-1",
    location: { latitude, longitude, timestamp: new Date(Date.UTC(2026, 9, 26, 12, 0, seconds)) }
});

/** Lets the coalesced background refresh run to completion. */
const settle = async () => {
    for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
};

/** A backend over a real FindMyFriendsCache, recording every side effect. */
const fakeBackend = (overrides: Partial<EncryptedFriendsBackend> = {}) => {
    const calls: string[] = [];
    const emitted: FindMyLocationItem[][] = [];
    const logs: string[] = [];
    const cache = new FindMyFriendsCache();
    let locations = [fix(33.1, -96.6, 0)];
    const backend: EncryptedFriendsBackend = {
        loadLocalStorageKey: () => LOCAL_STORAGE_KEY,
        loadFmfKey: async () => FMF_KEY,
        readRosterData: key => {
            assert.equal(key, FMF_KEY);
            calls.push("read-roster");
            return ROSTER_DATA;
        },
        readLocations: key => {
            assert.equal(key, LOCAL_STORAGE_KEY);
            calls.push("read-locations");
            return locations;
        },
        cache,
        label: async items => items.map(item => ({ ...item, short_address: "Dallas, TX", long_address: "Dallas, TX" })),
        bounce: async () => {
            calls.push("bounce");
        },
        isFindMyRunning: async () => true,
        quitFindMy: async () => {
            calls.push("quit");
        },
        // Mirrors PrivateApiFindMyEventHandler.handleNewLocation: store, then emit only what changed
        publish: async items => {
            calls.push("publish");
            const changed = cache.addAll(items);
            if (changed.length > 0) emitted.push(changed);
        },
        log: message => logs.push(message),
        ...overrides
    };
    return { backend, cache, calls, emitted, logs, setLocations: (next: typeof locations) => (locations = next) };
};

test("missing LocalStorage or FMF key returns the current cache without launching Find My", async () => {
    for (const missing of ["LocalStorage", "FMF"]) {
        const { backend, cache, calls, logs } = fakeBackend(
            missing === "LocalStorage" ? { loadLocalStorageKey: () => null } : { loadFmfKey: async () => null }
        );
        cache.add({
            handle: "dad@example.com",
            coordinates: [1, 2],
            long_address: null,
            short_address: null,
            subtitle: null,
            title: "Dad",
            last_updated: 5,
            is_locating_in_progress: false,
            status: "shallow"
        });

        const result = await refreshEncryptedFriends(backend);
        await settle();

        assert.deepEqual(calls, [], `${missing}: nothing read, Find My not launched`);
        assert.deepEqual(result, cache.getAll());
        assert.equal(result.length, 1);
        assert.match(logs.join("\n"), new RegExp(`${missing}.*key`, "i"));
    }
});

test("returns freshly decrypted, labelled friends before the background Find My bounce finishes", async () => {
    let releaseBounce!: () => void;
    const bounceBlocked = new Promise<void>(resolve => (releaseBounce = resolve));
    const { backend, calls } = fakeBackend({
        bounce: async () => {
            calls.push("bounce");
            await bounceBlocked;
        }
    });

    const result = await refreshEncryptedFriends(backend);

    assert.deepEqual(calls, ["bounce", "read-roster", "read-locations"]);
    const dad = result.find(item => item.handle === "dad@example.com");
    assert.deepEqual(dad.coordinates, [33.1, -96.6]);
    assert.equal(dad.title, "Dad");
    assert.equal(dad.status, "shallow");
    assert.equal(dad.short_address, "Dallas, TX");
    // The roster keeps friends without a location visible
    const mom = result.find(item => item.handle === "+15551234567");
    assert.equal(mom.title, "Mom");
    assert.deepEqual(mom.coordinates, [0, 0]);

    releaseBounce();
    await settle();
});

test("after the bounce, re-reads and emits only the friends whose location changed, once", async () => {
    const { backend, cache, emitted, setLocations } = fakeBackend();
    const mom = (seconds: number) => ({ ...fix(40.7, -74, seconds), findMyId: "friend-2~" });
    // Mirror production: publish labels before handing rows to handleNewLocation
    const publish = backend.publish;
    backend.publish = async items => publish(await backend.label(items));
    let releaseBounce!: () => void;
    const bounceBlocked = new Promise<void>(resolve => (releaseBounce = resolve));
    backend.bounce = async () => bounceBlocked;
    setLocations([fix(33.1, -96.6, 0), mom(0)]);

    await refreshEncryptedFriends(backend);
    // Find My fetched a newer fix for Dad only
    setLocations([fix(33.2, -96.7, 30), mom(0)]);
    releaseBounce();
    await settle();

    assert.equal(emitted.length, 1);
    assert.deepEqual(
        emitted[0].map(item => [item.handle, item.coordinates]),
        [["dad@example.com", [33.2, -96.7]]]
    );
    assert.deepEqual(cache.get("dad@example.com").coordinates, [33.2, -96.7]);
});

test("overlapping refreshes share one background Find My bounce", async () => {
    let releaseBounce!: () => void;
    const bounceBlocked = new Promise<void>(resolve => (releaseBounce = resolve));
    const { backend, calls } = fakeBackend({
        bounce: async () => {
            calls.push("bounce");
            await bounceBlocked;
        }
    });

    await Promise.all([refreshEncryptedFriends(backend), refreshEncryptedFriends(backend)]);
    releaseBounce();
    await settle();

    assert.equal(calls.filter(call => call === "bounce").length, 1);
    assert.equal(calls.filter(call => call === "publish").length, 1);
});

test("quits Find My after the background refresh only if it was not already running", async () => {
    for (const wasRunning of [true, false]) {
        const { backend, calls } = fakeBackend({ isFindMyRunning: async () => wasRunning });

        await refreshEncryptedFriends(backend);
        await settle();

        assert.equal(calls.includes("quit"), !wasRunning);
        if (!wasRunning) assert.equal(calls[calls.length - 1], "quit");
    }
});

test("openFindMyApp=false reads the encrypted cache without bouncing Find My", async () => {
    const { backend, calls } = fakeBackend();

    const result = await refreshEncryptedFriends(backend, false);
    await settle();

    assert.deepEqual(calls, ["read-roster", "read-locations"]);
    assert.ok(result.some(item => item.handle === "dad@example.com" && item.coordinates[0] === 33.1));
});

test("a transient decrypt or read failure keeps serving the last good cache", async () => {
    const { backend, cache, emitted, logs } = fakeBackend();
    await refreshEncryptedFriends(backend, false);
    const lastGood = cache.getAll();
    assert.deepEqual(cache.get("dad@example.com").coordinates, [33.1, -96.6]);

    const failures: Array<Partial<EncryptedFriendsBackend>> = [
        {
            readLocations: () => {
                throw new Error("Find My LocalStorage.db kept changing while being read");
            }
        },
        {
            readRosterData: () => {
                throw new Error("Find My cache authentication failed (wrong key or corrupt payload)");
            }
        },
        // A decryptable FMF payload with no friend list must not wipe the roster
        { readRosterData: () => ({}) }
    ];
    for (const failure of failures) {
        Object.assign(backend, failure);

        assert.deepEqual(await refreshEncryptedFriends(backend), lastGood);
        await settle();
        assert.deepEqual(cache.getAll(), lastGood);
    }
    assert.equal(emitted.length, 0);
    assert.ok(logs.length >= 6, "foreground and background failures are both logged");
});

test("macOS 14.4+ selects the encrypted backend; older versions keep the existing path", () => {
    const calls: string[] = [];
    const backends = {
        encrypted: () => {
            calls.push("encrypted");
            return "encrypted";
        },
        legacy: () => {
            calls.push("legacy");
            return "legacy";
        }
    };

    assert.equal(selectFindMyBackend(true, backends), "encrypted");
    assert.equal(selectFindMyBackend(false, backends), "legacy");
    assert.deepEqual(calls, ["encrypted", "legacy"]);
});
