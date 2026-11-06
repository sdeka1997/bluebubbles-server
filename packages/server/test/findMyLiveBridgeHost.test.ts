import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import test from "node:test";

import {
    findMyLiveLaunchArguments,
    FindMyLiveBridgeHost,
    FindMyLiveBridgeHostIo,
    FindMyLiveBridgeRequest,
    requestFindMyLiveBridge
} from "../src/server/api/lib/findmy/FindMyLiveBridgeHost";
import { FindMyLiveRejected } from "../src/server/api/lib/findmy/FindMyMirror";

const fakeIo = () => {
    const removed: string[] = [];
    const launches: Record<string, string>[] = [];
    const requests: FindMyLiveBridgeRequest[] = [];
    const waits: number[] = [];
    const replies: Array<Error | { status: "ok" | "error"; error?: string }> = [];
    let tokenNumber = 0;
    const io: FindMyLiveBridgeHostIo = {
        randomToken: () => `token-${++tokenNumber}`.padEnd(32, "x"),
        removeSocket: path => removed.push(path),
        launchFindMy: async environment => {
            launches.push(environment);
        },
        request: async (_path, request) => {
            requests.push(request);
            const reply = replies.shift() ?? { status: "ok" as const };
            if (reply instanceof Error) throw reply;
            return reply;
        },
        wait: async ms => {
            waits.push(ms);
        }
    };
    return { io, removed, launches, requests, replies, waits };
};

test("redacts the fresh token from launch failures", async () => {
    const world = fakeIo();
    world.io.launchFindMy = async environment => {
        throw new Error(`/usr/bin/open --env BBFM_LIVE_TOKEN=${environment.BBFM_LIVE_TOKEN} failed`);
    };
    const host = new FindMyLiveBridgeHost(world.io, "/resources/Bridge.dylib", "/container/tmp/live.sock");

    await assert.rejects(
        host.launch(),
        error => error instanceof Error && /launch Find My live bridge/.test(error.message) && !error.message.includes("token-")
    );
});

test("builds an explicit open argument vector without a shell", () => {
    assert.deepEqual(
        findMyLiveLaunchArguments({
            DYLD_INSERT_LIBRARIES: "/resources/Bridge.dylib",
            BBFM_LIVE_TOKEN: "secret token",
            BBFM_LIVE_SOCKET: "/container/tmp/live.sock"
        }),
        [
            "-g",
            "-j",
            "--env",
            "DYLD_INSERT_LIBRARIES=/resources/Bridge.dylib",
            "--env",
            "BBFM_LIVE_TOKEN=secret token",
            "--env",
            "BBFM_LIVE_SOCKET=/container/tmp/live.sock",
            "-a",
            "FindMy"
        ]
    );
});

test("sends one newline-framed request over the local socket and reads one reply", async () => {
    const socketPath = `/tmp/bbfm-host-test-${process.pid}.sock`;
    try {
        fs.unlinkSync(socketPath);
    } catch (_) {}
    const received: string[] = [];
    const server = net.createServer(socket => {
        socket.on("data", data => {
            received.push(data.toString());
            socket.end('{"status":"ok"}\n');
        });
    });
    await new Promise<void>((resolve, reject) => server.listen(socketPath, resolve).once("error", reject));
    try {
        const request: FindMyLiveBridgeRequest = { token: "token", command: "start", id: "opaque" };
        assert.deepEqual(await requestFindMyLiveBridge(socketPath, request), { status: "ok" });
        assert.deepEqual(received, [`${JSON.stringify(request)}\n`]);
    } finally {
        await new Promise<void>(resolve => server.close(() => resolve()));
        try {
            fs.unlinkSync(socketPath);
        } catch (_) {}
    }
});

const withBridgeServer = async (
    onConnection: (socket: net.Socket) => void,
    run: (socketPath: string) => Promise<void>
) => {
    const socketPath = `/tmp/bbfm-host-edge-${process.pid}-${Math.random().toString(16).slice(2)}.sock`;
    const sockets = new Set<net.Socket>();
    const server = net.createServer(socket => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        socket.on("error", () => undefined);
        onConnection(socket);
    });
    await new Promise<void>((resolve, reject) => server.listen(socketPath, resolve).once("error", reject));
    try {
        await run(socketPath);
    } finally {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>(resolve => server.close(() => resolve()));
        try {
            fs.unlinkSync(socketPath);
        } catch (_) {}
    }
};

const startRequest: FindMyLiveBridgeRequest = { token: "token", command: "start", id: "opaque" };

test("accepts a reply split across several socket writes", async () => {
    await withBridgeServer(
        socket => {
            socket.once("data", () => {
                socket.write('{"sta');
                setTimeout(() => socket.write('tus":"ok"}\n'), 20);
            });
        },
        async socketPath => assert.deepEqual(await requestFindMyLiveBridge(socketPath, startRequest), { status: "ok" })
    );
});

test("rejects a bridge that never replies within the timeout", async () => {
    await withBridgeServer(
        () => undefined,
        async socketPath => {
            const started = Date.now();
            await assert.rejects(requestFindMyLiveBridge(socketPath, startRequest), /timed out/);
            assert.ok(Date.now() - started < 5000);
        }
    );
});

test("rejects an oversized reply without waiting for a newline", async () => {
    await withBridgeServer(
        socket => socket.once("data", () => socket.write("x".repeat(9000))),
        async socketPath => await assert.rejects(requestFindMyLiveBridge(socketPath, startRequest), /too large/)
    );
});

test("rejects malformed JSON and an unknown status", async () => {
    await withBridgeServer(
        socket => socket.once("data", () => socket.end("not json\n")),
        async socketPath => await assert.rejects(requestFindMyLiveBridge(socketPath, startRequest), /Invalid/)
    );
    await withBridgeServer(
        socket => socket.once("data", () => socket.end('{"status":"maybe"}\n')),
        async socketPath => await assert.rejects(requestFindMyLiveBridge(socketPath, startRequest), /Invalid/)
    );
});

test("rejects a bridge that closes without a complete reply", async () => {
    await withBridgeServer(
        socket => socket.once("data", () => socket.end('{"status":"ok"}')),
        async socketPath => await assert.rejects(requestFindMyLiveBridge(socketPath, startRequest), /closed without a reply/)
    );
});

test("rejects a missing socket instead of hanging", async () => {
    await assert.rejects(requestFindMyLiveBridge(`/tmp/bbfm-missing-${process.pid}.sock`, startRequest), /ENOENT/);
});

test("stops only an active host, resets its socket, and uses a fresh token on relaunch", async () => {
    const world = fakeIo();
    const host = new FindMyLiveBridgeHost(world.io, "/resources/Bridge.dylib", "/container/tmp/live.sock");

    await host.stop();
    assert.deepEqual(world.requests, []);

    await host.launch();
    const firstToken = world.launches[0].BBFM_LIVE_TOKEN;
    await host.start("friend-one");
    await host.stop();
    assert.deepEqual(world.requests.at(-1), { token: firstToken, command: "stop" });

    host.reset();
    const afterReset = world.requests.length;
    await host.stop();
    assert.equal(world.requests.length, afterReset);
    assert.deepEqual(world.removed, ["/container/tmp/live.sock", "/container/tmp/live.sock"]);

    await host.launch();
    assert.notEqual(world.launches[1].BBFM_LIVE_TOKEN, firstToken);
});

test("does not retry a permanent bridge rejection", async () => {
    const world = fakeIo();
    const host = new FindMyLiveBridgeHost(world.io, "/resources/Bridge.dylib", "/container/tmp/live.sock");
    world.replies.push({ status: "error", error: "friend not found" });

    await host.launch();
    await assert.rejects(host.start("missing-id"), (error: unknown) => {
        assert.ok(error instanceof FindMyLiveRejected, "Find My's answer about this friend, not a broken bridge");
        assert.match(String(error), /friend not found/);
        return true;
    });

    assert.equal(world.requests.length, 1);
    assert.deepEqual(world.waits, []);
});

test("launches one token-authenticated host and starts the opaque Apple friend after it is ready", async () => {
    const world = fakeIo();
    const host = new FindMyLiveBridgeHost(world.io, "/resources/Bridge.dylib", "/container/tmp/live.sock");
    world.replies.push(new Error("ENOENT"), { status: "error", error: "Find My is not ready" }, { status: "ok" });

    await host.launch();
    await host.start("opaque-friend-id");

    assert.deepEqual(world.removed, ["/container/tmp/live.sock"]);
    assert.equal(world.launches.length, 1);
    assert.equal(world.launches[0].DYLD_INSERT_LIBRARIES, "/resources/Bridge.dylib");
    assert.equal(world.launches[0].BBFM_LIVE_SOCKET, "/container/tmp/live.sock");
    assert.equal(world.launches[0].BBFM_LIVE_TOKEN.length, 32);
    assert.deepEqual(world.requests, [
        { token: world.launches[0].BBFM_LIVE_TOKEN, command: "start", id: "opaque-friend-id" },
        { token: world.launches[0].BBFM_LIVE_TOKEN, command: "start", id: "opaque-friend-id" },
        { token: world.launches[0].BBFM_LIVE_TOKEN, command: "start", id: "opaque-friend-id" }
    ]);
    assert.deepEqual(world.waits, [100, 100]);
});
