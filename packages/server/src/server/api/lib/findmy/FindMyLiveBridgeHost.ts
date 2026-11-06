import net from "node:net";

import { FindMyBridgeNotReady, FindMyLiveRejected } from "./FindMyMirror";

export type FindMyLiveBridgeRequest = {
    token: string;
    command: "start" | "stop";
    id?: string;
};

export type FindMyLiveBridgeReply = { status: "ok" | "error"; error?: string };

export type FindMyLiveBridgeHostIo = {
    randomToken: () => string;
    removeSocket: (path: string) => void;
    launchFindMy: (environment: Record<string, string>) => Promise<void>;
    request: (socketPath: string, request: FindMyLiveBridgeRequest) => Promise<FindMyLiveBridgeReply>;
    /** Whether a bridge accepts connections on the socket, which only a Find My launched with it does */
    isListening: (socketPath: string) => Promise<boolean>;
};

const REPLY_LIMIT = 8192;
const REQUEST_TIMEOUT_MS = 2000;

/** The bridge's answers about the friend itself; any other error is about the launch. */
const FRIEND_REJECTIONS = new Set(["friend not found", "friend id is not unique"]);

/** Explicit argv for `open`; no token or path is interpolated through a shell. */
export const findMyLiveLaunchArguments = (environment: Record<string, string>): string[] => [
    "-g",
    "-j",
    "--env",
    `DYLD_INSERT_LIBRARIES=${environment.DYLD_INSERT_LIBRARIES}`,
    "--env",
    `BBFM_LIVE_TOKEN=${environment.BBFM_LIVE_TOKEN}`,
    "--env",
    `BBFM_LIVE_SOCKET=${environment.BBFM_LIVE_SOCKET}`,
    "-a",
    "FindMy"
];

/** No reply in time: Find My's main thread, where every command runs, is busy. */
export class FindMyBridgeTimedOut extends Error {
    constructor() {
        super("Find My live bridge timed out");
    }
}

/** Socket errors meaning nothing listens there yet: Find My has not loaded the bridge yet, or has gone. */
const NOT_LISTENING = new Set(["ENOENT", "ECONNREFUSED"]);

/** Whether anything accepts a connection on the socket. Sends nothing, so needs no token. */
export const isFindMyLiveBridgeListening = (socketPath: string): Promise<boolean> =>
    new Promise(resolve => {
        const socket = net.createConnection(socketPath);
        const finish = (listening: boolean) => {
            socket.destroy();
            resolve(listening);
        };
        socket.setTimeout(REQUEST_TIMEOUT_MS, () => finish(false));
        socket.once("connect", () => finish(true));
        socket.once("error", () => finish(false));
    });

/** Sends one command and accepts one bounded newline-framed reply. */
export const requestFindMyLiveBridge = (
    socketPath: string,
    request: FindMyLiveBridgeRequest
): Promise<FindMyLiveBridgeReply> =>
    new Promise((resolve, reject) => {
        const socket = net.createConnection(socketPath);
        let reply = "";
        let settled = false;
        const finish = (error?: unknown, value?: FindMyLiveBridgeReply) => {
            if (settled) return;
            settled = true;
            socket.destroy();
            if (error) reject(error);
            else resolve(value!);
        };
        socket.setTimeout(REQUEST_TIMEOUT_MS, () => finish(new FindMyBridgeTimedOut()));
        socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
        socket.on("data", data => {
            reply += data.toString("utf8");
            if (reply.length > REPLY_LIMIT) return finish(new Error("Find My live bridge reply is too large"));
            const newline = reply.indexOf("\n");
            if (newline < 0) return;
            try {
                const parsed = JSON.parse(reply.slice(0, newline));
                if (parsed?.status !== "ok" && parsed?.status !== "error") throw new Error("invalid status");
                finish(undefined, parsed as FindMyLiveBridgeReply);
            } catch (error) {
                finish(new Error(`Invalid Find My live bridge reply: ${error}`));
            }
        });
        socket.once("error", error => finish(error));
        socket.once("end", () => {
            if (!settled) finish(new Error("Find My live bridge closed without a reply"));
        });
    });

/**
 * One injected Find My launch. The token is fresh per launch and never leaves
 * this Mac; commands travel only over Find My's user-owned Unix socket.
 */
export class FindMyLiveBridgeHost {
    private token: string | null = null;

    constructor(
        private readonly io: FindMyLiveBridgeHostIo,
        private readonly bridgePath: string,
        private readonly socketPath: string
    ) {}

    async launch(): Promise<void> {
        this.token = this.io.randomToken();
        this.io.removeSocket(this.socketPath);
        try {
            await this.io.launchFindMy({
                DYLD_INSERT_LIBRARIES: this.bridgePath,
                BBFM_LIVE_TOKEN: this.token,
                BBFM_LIVE_SOCKET: this.socketPath
            });
        } catch (_) {
            this.token = null;
            throw new Error("Unable to launch Find My live bridge");
        }
    }

    async stop(): Promise<void> {
        if (!this.token) return;
        // A bridge not ready yet has not started following anyone
        const reply = await this.send({ token: this.token, command: "stop" }).catch(error => {
            if (error instanceof FindMyBridgeNotReady) return { status: "ok" as const };
            throw error;
        });
        if (reply.status === "error") throw new Error(reply.error ?? "Find My live bridge rejected stop");
    }

    /** Whether the Find My running is one launched with this bridge. */
    isOurs(): Promise<boolean> {
        return this.io.isListening(this.socketPath);
    }

    reset(): void {
        this.token = null;
        this.io.removeSocket(this.socketPath);
    }

    /** One request; the mirror's next check asks again while Find My is still starting. */
    async start(friendId: string): Promise<void> {
        if (!this.token) throw new Error("Find My live bridge has not launched");
        const reply = await this.send({ token: this.token, command: "start", id: friendId });
        if (reply.status === "ok") return;
        // Find My's answer about this friend, which a retry won't change
        if (reply.error && FRIEND_REJECTIONS.has(reply.error)) throw new FindMyLiveRejected(reply.error);
        throw new Error(reply.error ?? "Find My live bridge rejected start");
    }

    private async send(request: FindMyLiveBridgeRequest): Promise<FindMyLiveBridgeReply> {
        let reply: FindMyLiveBridgeReply;
        try {
            reply = await this.io.request(this.socketPath, request);
        } catch (error: any) {
            // Not loaded yet, or busy: the next check asks again, under the mirror's time limit
            if (NOT_LISTENING.has(error?.code) || error instanceof FindMyBridgeTimedOut) throw new FindMyBridgeNotReady();
            throw error;
        }
        if (reply.status === "error" && reply.error === "Find My is not ready") throw new FindMyBridgeNotReady();
        return reply;
    }
}
