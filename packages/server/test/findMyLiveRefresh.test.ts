import assert from "node:assert/strict";
import test from "node:test";

import {
    FIND_MY_COLLECT_MS,
    FindMyLiveRefresh,
    LiveRefreshIo
} from "../src/server/api/lib/findmy/FindMyLiveRefresh";

type Fingerprint = { size: number; mtimeMs: number; ino: number };

const settle = async () => {
    for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
};

/** Find My, its files and a clock, all fake. `advance` runs due timers in order. */
const fakeWorld = (options: { neverStarts?: boolean } = {}) => {
    const calls: string[] = [];
    const logs: string[] = [];
    const files = new Map<string, Fingerprint>([
        ["db", { size: 1, mtimeMs: 1, ino: 1 }],
        ["db-wal", { size: 1, mtimeMs: 1, ino: 2 }],
        ["Devices.data", { size: 1, mtimeMs: 1, ino: 3 }]
    ]);
    let running = true;
    let now = 0;
    let timers: { at: number; fn: () => void; id: number }[] = [];
    let nextId = 0;
    let releasePublish: (() => void) | null = null;
    let blockPublish = false;

    const io: LiveRefreshIo = {
        isFindMyRunning: async () => running,
        quitFindMy: async () => {
            calls.push("quit");
            // Quitting takes a moment to register, as it does for the real app
            io.schedule(() => (running = false), 200);
        },
        launchFindMyHidden: async () => {
            calls.push("launch-hidden");
            if (!options.neverStarts) io.schedule(() => (running = true), 300);
        },
        friendFiles: () => ["db", "db-wal"],
        deviceFiles: () => ["Devices.data"],
        stat: file => files.get(file) ?? null,
        publishFriends: async () => {
            calls.push("publish-friends");
            if (blockPublish) await new Promise<void>(resolve => (releasePublish = resolve));
        },
        publishDevices: async () => {
            calls.push("publish-devices");
        },
        schedule: (fn, ms) => {
            const id = nextId++;
            timers.push({ at: now + ms, fn, id });
            return () => {
                timers = timers.filter(timer => timer.id !== id);
            };
        },
        now: () => now,
        log: message => logs.push(message)
    };

    const advance = async (ms: number) => {
        const target = now + ms;
        await settle();
        for (;;) {
            timers.sort((a, b) => a.at - b.at || a.id - b.id);
            const due = timers[0];
            if (!due || due.at > target) break;
            timers.shift();
            now = due.at;
            due.fn();
            await settle();
        }
        now = target;
        await settle();
    };

    const touch = (file: string) => {
        const current = files.get(file)!;
        files.set(file, { ...current, mtimeMs: current.mtimeMs + 1 });
    };

    return {
        io,
        calls,
        logs,
        advance,
        touch,
        isRunning: () => running,
        pendingTimers: () => timers.length,
        blockPublishes: () => (blockPublish = true),
        releasePublish: () => {
            blockPublish = false;
            releasePublish?.();
        }
    };
};

test("relaunches Find My hidden, waiting only until each step has happened", async () => {
    const world = fakeWorld();
    const refresh = new FindMyLiveRefresh(world.io);

    const relaunched = refresh.start();
    await world.advance(150);
    assert.deepEqual(world.calls, ["quit"], "waits for Find My to finish quitting before launching it");

    await world.advance(100);
    assert.deepEqual(world.calls, ["quit", "launch-hidden"]);
    await world.advance(400);
    assert.equal(await relaunched, true);
    assert.equal(world.isRunning(), true);
    // Quit registered at 200 ms and launch at 300 ms after it: the whole relaunch is under a
    // second, where the old bounce slept 3 + 5 + 15 s regardless.
    assert.ok(refresh.isActive);
});

test("publishes friends as soon as Find My writes their file, and devices as soon as theirs change", async () => {
    const world = fakeWorld();
    const refresh = new FindMyLiveRefresh(world.io);
    void refresh.start();
    await world.advance(1000);
    world.calls.length = 0;

    await world.advance(3000);
    assert.deepEqual(world.calls, [], "nothing changed, nothing is published");

    world.touch("db-wal");
    await world.advance(1000);
    assert.deepEqual(world.calls, ["publish-friends"]);

    world.touch("Devices.data");
    await world.advance(1000);
    assert.deepEqual(world.calls, ["publish-friends", "publish-devices"]);
});

test("a refresh requested while one is collecting does not relaunch Find My", async () => {
    const world = fakeWorld();
    const refresh = new FindMyLiveRefresh(world.io);
    void refresh.start();
    await world.advance(1000);

    assert.equal(await refresh.start(), false);
    await world.advance(1000);
    assert.equal(world.calls.filter(call => call === "launch-hidden").length, 1);
});

test("with nobody watching, collects for five minutes then quits Find My and stops checking", async () => {
    const world = fakeWorld();
    const refresh = new FindMyLiveRefresh(world.io);
    void refresh.start();

    await world.advance(FIND_MY_COLLECT_MS - 1000);
    assert.ok(refresh.isActive);
    assert.equal(world.calls.filter(call => call === "quit").length, 1);

    await world.advance(2000);
    assert.equal(refresh.isActive, false);
    assert.equal(world.calls.filter(call => call === "quit").length, 2, "quits Find My at the end");
    await world.advance(1000);
    assert.equal(world.pendingTimers(), 0, "no checks keep running after the refresh ends");
});

test("an open Find My screen keeps it collecting past five minutes, until the screen closes", async () => {
    const world = fakeWorld();
    const refresh = new FindMyLiveRefresh(world.io);
    refresh.setViewer("pixel", true);
    void refresh.start();

    await world.advance(FIND_MY_COLLECT_MS + 60_000);
    assert.ok(refresh.isActive, "still collecting while the screen is open");

    world.touch("db");
    await world.advance(1000);
    assert.equal(world.calls.at(-1), "publish-friends");

    refresh.setViewer("pixel", false);
    await world.advance(1000);
    assert.equal(refresh.isActive, false);
    assert.equal(world.calls.filter(call => call === "quit").length, 2);
});

test("closing the screen early still collects for the full five minutes", async () => {
    const world = fakeWorld();
    const refresh = new FindMyLiveRefresh(world.io);
    refresh.setViewer("pixel", true);
    void refresh.start();
    await world.advance(30_000);

    refresh.setViewer("pixel", false);
    await world.advance(60_000);
    assert.ok(refresh.isActive);

    await world.advance(FIND_MY_COLLECT_MS);
    assert.equal(refresh.isActive, false);
});

test("a write during a publish is published again once that publish finishes", async () => {
    const world = fakeWorld();
    const refresh = new FindMyLiveRefresh(world.io);
    void refresh.start();
    await world.advance(1000);
    world.calls.length = 0;

    world.blockPublishes();
    world.touch("db");
    await world.advance(1000);
    world.touch("db");
    await world.advance(3000);
    assert.deepEqual(world.calls, ["publish-friends"], "one publish at a time");

    world.releasePublish();
    await world.advance(1000);
    assert.deepEqual(world.calls, ["publish-friends", "publish-friends"]);
});

test("a Find My that never starts ends the refresh, so the next one can try again", async () => {
    const world = fakeWorld({ neverStarts: true });
    const refresh = new FindMyLiveRefresh(world.io);

    const relaunched = refresh.start();
    await world.advance(30_000);
    assert.equal(await relaunched, false);
    assert.equal(refresh.isActive, false);
    assert.match(world.logs.join("\n"), /did not start/);
    assert.equal(world.pendingTimers(), 0);
});
