import net from "node:net";

import { FindMyLiveRejected } from "./FindMyMirror";

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
    wait: (ms: number) => Promise<void>;
};

const READY_RETRY_MS = 100;
const READY_ATTEMPTS = 200;
const REPLY_LIMIT = 8192;
const REQUEST_TIMEOUT_MS = 2000;

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
        socket.setTimeout(REQUEST_TIMEOUT_MS, () => finish(new Error("Find My live bridge timed out")));
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
        const reply = await this.io.request(this.socketPath, { token: this.token, command: "stop" });
        if (reply.status === "error") throw new Error(reply.error ?? "Find My live bridge rejected stop");
    }

    reset(): void {
        this.token = null;
        this.io.removeSocket(this.socketPath);
    }

    async start(friendId: string): Promise<void> {
        if (!this.token) throw new Error("Find My live bridge has not launched");
        const request: FindMyLiveBridgeRequest = { token: this.token, command: "start", id: friendId };
        let lastError: unknown = new Error("Find My live bridge did not become ready");
        for (let attempt = 0; attempt < READY_ATTEMPTS; attempt++) {
            let reply: FindMyLiveBridgeReply | null = null;
            try {
                reply = await this.io.request(this.socketPath, request);
            } catch (error) {
                lastError = error;
            }
            if (reply?.status === "ok") return;
            if (reply?.status === "error") {
                // Anything but "not ready" is Find My's answer about this friend, which a retry won't change
                if (reply.error !== "Find My is not ready") {
                    throw new FindMyLiveRejected(reply.error ?? "Find My live bridge rejected start");
                }
                lastError = new Error(reply.error);
            }
            if (attempt + 1 < READY_ATTEMPTS) await this.io.wait(READY_RETRY_MS);
        }
        throw lastError;
    }
}
