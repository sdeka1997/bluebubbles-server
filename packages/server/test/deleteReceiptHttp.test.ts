// Exercises the real Koa stack: HttpService.configureKoa() -> HttpRoutes -> Auth/PrivateApi middleware
// -> validators -> ChatRouter -> ChatInterface -> PrivateApiService.writeData, against a real
// ServerRepository on temp SQLite. Only Electron and the helper's TCP socket are stood in for.
import { userDataDir } from "./support/electronStub";

import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import { AddressInfo } from "node:net";
import { dirname } from "node:path";
import { after, before, beforeEach, test } from "node:test";

// eslint-disable-next-line max-len
import type { RecoverableDeleteReceipt as ReceiptEntity } from "../src/server/databases/server/entity/RecoverableDeleteReceipt";
// eslint-disable-next-line max-len
import type { RecoverableDeleteReceiptTable1760659200000 as ReceiptMigration } from "../src/server/databases/server/migrations/1760659200000-RecoverableDeleteReceiptTable";

// TransactionPromise arms a 2-minute timeout per request; unref long timers so the test process can exit
const realSetTimeout = global.setTimeout;
global.setTimeout = ((handler: (...args: any[]) => void, ms?: number, ...args: any[]) => {
    const timer = realSetTimeout(handler, ms, ...args);
    if ((ms ?? 0) >= 60_000) timer.unref();
    return timer;
}) as typeof setTimeout;

const load = createRequire(import.meta.url);

const PASSWORD = "receipt-test-password";
const CHAT = "iMessage;-;+15555550123";
const OTHER_CHAT = "iMessage;+;chat999999999999999999";
const ATTEMPTS = "/api/v1/chat/delete/recoverable/attempts";

type HelperMode = "ack" | "pause" | "writeError" | "helperError" | "timeout";
type HelperWrite = { action: string; data: { chatGuid: string }; transactionId: string };

let Server: typeof import("../src/server").Server;
let ChatInterface: typeof import("../src/server/api/interfaces/chatInterface").ChatInterface;
let ReceiptModule: typeof import("../src/server/services/RecoverableDeleteReceiptService");
let RecoverableDeleteReceipt: typeof ReceiptEntity;
let RecoverableDeleteReceiptTable: typeof ReceiptMigration;
let httpServer: http.Server;
let baseUrl: string;
const logLines: string[] = [];

const helper = {
    mode: "ack" as HelperMode,
    writes: [] as HelperWrite[],
    releasePaused: [] as Array<() => void>,
    onWrite: null as null | ((write: HelperWrite) => void)
};

const fakeHelperSocket = {
    destroyed: false,
    destroy: () => undefined,
    write(raw: string, callback: (err?: Error) => void) {
        const write = JSON.parse(raw) as HelperWrite;
        helper.writes.push(write);
        helper.onWrite?.(write);
        if (helper.mode === "writeError") {
            setImmediate(() => callback(new Error("EPIPE")));
            return false;
        }

        setImmediate(() => callback());
        const transaction = () => Server().privateApi.transactionManager.find(write.transactionId);
        const settle = () => {
            if (helper.mode === "helperError") transaction()?.reject("helper reported an error");
            else if (helper.mode === "timeout") transaction()?.reject("Transaction timeout");
            else transaction()?.resolve(write.data.chatGuid);
        };
        if (helper.mode === "pause") helper.releasePaused.push(() => setImmediate(settle));
        else setImmediate(() => setImmediate(settle));
        return true;
    }
};

const connectHelper = () => {
    const privateApi = Server().privateApi as any;
    privateApi.server = {};
    privateApi.clients = [fakeHelperSocket];
};

const disconnectHelper = () => {
    const privateApi = Server().privateApi as any;
    privateApi.server = null;
    privateApi.clients = [];
};

const request = async (
    method: string,
    path: string,
    { body, password = PASSWORD }: { body?: unknown; password?: string | null } = {}
) => {
    const url = new URL(path, baseUrl);
    if (password !== null) url.searchParams.set("password", password);
    const response = await fetch(url, {
        method,
        headers: body === undefined ? {} : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    let json: any = null;
    try {
        json = JSON.parse(text);
    } catch {
        json = { text };
    }
    return { status: response.status, json };
};

const submit = (body: unknown, password?: string | null) => request("POST", ATTEMPTS, { body, password });
const status = (attemptId: string, password?: string | null) =>
    request("GET", `${ATTEMPTS}/${attemptId}`, { password });
const receiptRow = (attemptId: string) =>
    Server().repo.receiptDb.getRepository(RecoverableDeleteReceipt).findOneBy({ attemptId });
const receiptCount = () => Server().repo.receiptDb.getRepository(RecoverableDeleteReceipt).count();
const attempt = (label: string) => `http_${label}`.padEnd(24, "Q");

before(async () => {
    mkdirSync(`${userDataDir}/bluebubbles-server`, { recursive: true });
    // Load through require so the test shares one module graph with the server's own requires
    ({ Server } = load("../src/server"));
    ({ ChatInterface } = load("../src/server/api/interfaces/chatInterface"));
    ReceiptModule = load("../src/server/services/RecoverableDeleteReceiptService");
    ({ RecoverableDeleteReceipt } = load("../src/server/databases/server/entity/RecoverableDeleteReceipt"));
    ({ RecoverableDeleteReceiptTable1760659200000: RecoverableDeleteReceiptTable } = load(
        "../src/server/databases/server/migrations/1760659200000-RecoverableDeleteReceiptTable"
    ));
    const { ServerRepository } = load("../src/server/databases/server");
    const { PrivateApiService } = load("../src/server/api/privateApi/PrivateApiService");
    const { HttpService } = load("../src/server/api/http");
    const KoaApp = load("koa");

    // Every server log line (request logs, controller and service logs) flows through Server().log
    const server = Server();
    server.log = (message: any) => {
        logLines.push(String(message));
    };
    server.repo = new ServerRepository();
    await server.repo.initialize();
    await server.repo.setConfig("password", PASSWORD);
    await server.repo.setConfig("enable_private_api", true);
    server.privateApi = new PrivateApiService();

    const httpService = new HttpService();
    httpService.koaApp = new KoaApp();
    httpService.configureKoa();
    httpServer = http.createServer(httpService.koaApp.callback());
    await new Promise<void>(resolve => httpServer.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});

after(async () => {
    await new Promise(resolve => httpServer?.close(resolve));
    await Server().repo?.receiptDb?.destroy();
    await Server().repo?.db?.destroy();
    rmSync(userDataDir, { recursive: true, force: true });
});

beforeEach(() => {
    helper.mode = "ack";
    helper.writes = [];
    helper.releasePaused = [];
    helper.onWrite = null;
    connectHelper();
});

test("real server repository keeps receipts in their own migrated SQLite file", async () => {
    const { db, receiptDb } = Server().repo;
    assert.notEqual(receiptDb, db);
    assert.ok(receiptDb.isInitialized);
    assert.notEqual(receiptDb.options.database, db.options.database);
    assert.equal(dirname(receiptDb.options.database as string), dirname(db.options.database as string));

    // Receipts are absent from the main DataSource, so no main-database transaction can capture them
    assert.ok(!(db.options.entities as unknown[]).includes(RecoverableDeleteReceipt));
    assert.ok(!(db.options.migrations as unknown[]).includes(RecoverableDeleteReceiptTable));
    assert.equal(await db.createQueryRunner().hasTable("recoverable_delete_receipt"), false);
    const mainNames = (db.options.migrations as Array<new () => { name: string }>).map(
        Migration => new Migration().name
    );
    const mainStamps = mainNames.map(name => Number(name.match(/(\d{13})$/)?.[1]));
    assert.deepEqual(
        [...mainStamps].sort((a, b) => a - b),
        mainStamps,
        "migrations must stay in timestamp order"
    );
    assert.equal(new Set(mainNames).size, mainNames.length);

    assert.deepEqual(receiptDb.options.entities, [RecoverableDeleteReceipt]);
    assert.deepEqual(receiptDb.options.migrations, [RecoverableDeleteReceiptTable]);
    assert.deepEqual(
        (await receiptDb.query(`SELECT name FROM migrations`)).map((row: { name: string }) => row.name),
        [new RecoverableDeleteReceiptTable().name]
    );

    // The migrated table is exactly what the entity describes, and re-running the migration is harmless
    assert.equal(await receiptDb.createQueryRunner().hasTable("recoverable_delete_receipt"), true);
    const schemaDiff = await receiptDb.driver.createSchemaBuilder().log();
    assert.deepEqual(
        schemaDiff.upQueries.map(query => query.query),
        []
    );
    await new RecoverableDeleteReceiptTable().up(receiptDb.createQueryRunner());
});

test("submit dispatches once through the real helper path and status reports it", async () => {
    const id = attempt("happy");
    const first = await submit({ chatGuid: CHAT, attemptId: id });
    assert.equal(first.status, 200);
    assert.equal(first.json.data.attemptId, id);
    assert.equal(first.json.data.state, "succeeded");
    assert.equal(first.json.data.failureCode, null);
    assert.equal(typeof first.json.data.createdAt, "number");
    assert.equal(first.json.data.chatGuid, undefined);
    assert.equal(first.json.data.chatGuidHash, undefined);
    assert.deepEqual(
        helper.writes.map(write => [write.action, write.data.chatGuid]),
        [["recoverable-delete-chat", CHAT]]
    );

    const repeat = await submit({ chatGuid: CHAT, attemptId: id });
    assert.equal(repeat.status, 200);
    assert.equal(repeat.json.data.state, "succeeded");
    assert.equal(helper.writes.length, 1);

    const got = await status(id);
    assert.equal(got.status, 200);
    assert.deepEqual(got.json.data, first.json.data);

    assert.equal((await status(attempt("neverSubmitted"))).status, 404);
});

test("pending is visible over HTTP while the helper is paused", async () => {
    helper.mode = "pause";
    const id = attempt("paused");
    let dispatched: () => void;
    const helperReached = new Promise<void>(resolve => {
        dispatched = resolve;
    });
    helper.onWrite = () => dispatched();

    const submission = submit({ chatGuid: CHAT, attemptId: id });
    await helperReached;
    const during = await status(id);
    assert.equal(during.status, 200);
    assert.equal(during.json.data.state, "pending");

    helper.releasePaused.forEach(release => release());
    assert.equal((await submission).json.data.state, "succeeded");
    assert.equal((await status(id)).json.data.state, "succeeded");
});

test("concurrent HTTP submissions of one attempt reach the helper once", async () => {
    const id = attempt("concurrent");
    const responses = await Promise.all(Array.from({ length: 6 }, () => submit({ chatGuid: CHAT, attemptId: id })));
    assert.deepEqual(new Set(responses.map(response => response.status)), new Set([200]));
    assert.equal(helper.writes.length, 1);
    assert.equal((await status(id)).json.data.state, "succeeded");
});

test("a different chat on a used attempt returns 409 without a helper call", async () => {
    const id = attempt("conflict");
    assert.equal((await submit({ chatGuid: CHAT, attemptId: id })).status, 200);
    const conflict = await submit({ chatGuid: OTHER_CHAT, attemptId: id });
    assert.equal(conflict.status, 409);
    assert.equal(helper.writes.length, 1);
    assert.ok(!JSON.stringify(conflict.json).includes(CHAT));
    assert.ok(!JSON.stringify(conflict.json).includes(OTHER_CHAT));
});

test("malformed attempt ids and chat GUIDs are rejected before any receipt or helper call", async () => {
    const before = await receiptCount();
    const badIds: unknown[] = [
        "short",
        "A".repeat(129),
        ["A".repeat(20)],
        1234567890123456,
        null,
        { id: "A".repeat(20) },
        "../../" + "A".repeat(20),
        "A".repeat(20) + "/../x",
        "A".repeat(20) + "%2F..",
        "A".repeat(20) + "=",
        "A".repeat(20) + " "
    ];
    for (const attemptId of badIds) {
        const response = await submit({ chatGuid: CHAT, attemptId });
        assert.equal(response.status, 400, JSON.stringify(attemptId));
    }
    assert.equal((await submit({ chatGuid: CHAT })).status, 400);
    for (const chatGuid of [undefined, "", ["x"], 42, "x".repeat(1025)]) {
        assert.equal((await submit({ chatGuid, attemptId: attempt("badChat") })).status, 400);
    }

    for (const path of ["short", "A".repeat(129), "..%2F..%2F" + "A".repeat(20), "A".repeat(20) + "%20"]) {
        assert.equal((await status(path)).status, 400, path);
    }
    // Extra path segments never reach the status controller
    assert.equal((await status(`${attempt("x")}/extra`)).status, 404);

    assert.equal(helper.writes.length, 0);
    assert.equal(await receiptCount(), before);
});

test("status works while the helper is offline; submit keeps its auth and helper middleware", async () => {
    const id = attempt("offline");
    assert.equal((await submit({ chatGuid: CHAT, attemptId: id })).status, 200);
    disconnectHelper();
    await Server().repo.setConfig("enable_private_api", false);
    try {
        const offline = await status(id);
        assert.equal(offline.status, 200);
        assert.equal(offline.json.data.state, "succeeded");

        const blocked = await submit({ chatGuid: CHAT, attemptId: attempt("offlineSubmit") });
        assert.equal(blocked.status, 500);
        assert.equal(blocked.json.error.type, "iMessage Error");
        assert.equal(await receiptRow(attempt("offlineSubmit")), null);
    } finally {
        await Server().repo.setConfig("enable_private_api", true);
    }

    for (const password of [null, "wrong-password"]) {
        assert.equal((await status(id, password)).status, 401);
        assert.equal((await submit({ chatGuid: CHAT, attemptId: attempt("noAuth") }, password)).status, 401);
    }
    assert.equal(await receiptRow(attempt("noAuth")), null);
    assert.equal(helper.writes.length, 1);
});

test("real ChatInterface classification: typed pre-dispatch vs ambiguous failures", async () => {
    const service = new ReceiptModule.RecoverableDeleteReceiptService(Server().repo.receiptDb);
    const run = (label: string) =>
        service.submit(attempt(label), CHAT, () => ChatInterface.recoverableDeleteForReceipt(CHAT));

    assert.equal((await run("classOk")).state, "succeeded");

    disconnectHelper();
    const offline = await run("classOffline");
    assert.equal(offline.state, "definitiveFailure");
    assert.equal(offline.failureCode, "privateApiUnavailable");
    connectHelper();

    await Server().repo.setConfig("enable_private_api", false);
    const disabled = await run("classDisabled");
    await Server().repo.setConfig("enable_private_api", true);
    assert.equal(disabled.state, "definitiveFailure");
    assert.equal(disabled.failureCode, "privateApiUnavailable");

    for (const mode of ["writeError", "helperError", "timeout"] as HelperMode[]) {
        helper.mode = mode;
        const result = await run(`class_${mode}`);
        assert.equal(result.state, "pending", mode);
        assert.equal((await receiptRow(attempt(`class_${mode}`)))?.state, "pending", mode);
    }
    helper.mode = "ack";

    // Pending receipts are never retried, even once the helper is healthy again
    const writesBefore = helper.writes.length;
    assert.equal((await run("class_timeout")).state, "pending");
    assert.equal(helper.writes.length, writesBefore);
});

test("legacy POST /chat/:guid/delete/recoverable behaves exactly as before and writes no receipt", async () => {
    const legacyPath = `/api/v1/chat/${encodeURIComponent(CHAT)}/delete/recoverable`;
    const before = await receiptCount();

    const ok = await request("POST", legacyPath);
    assert.equal(ok.status, 200);
    assert.equal(ok.json.message, "Successfully recoverably deleted chat!");
    assert.equal(ok.json.data, undefined);

    const withAttempt = await request("POST", legacyPath, { body: { attemptId: attempt("legacy") } });
    assert.equal(withAttempt.status, 200);
    assert.equal(withAttempt.json.message, "Successfully recoverably deleted chat!");
    assert.deepEqual(
        helper.writes.map(write => [write.action, write.data.chatGuid]),
        [
            ["recoverable-delete-chat", CHAT],
            ["recoverable-delete-chat", CHAT]
        ]
    );

    helper.mode = "writeError";
    const failed = await request("POST", legacyPath);
    assert.equal(failed.status, 500);
    assert.match(failed.json.error.message, /Failed to send recoverable chat deletion/);

    disconnectHelper();
    const offline = await request("POST", legacyPath);
    assert.equal(offline.status, 500);
    assert.equal(offline.json.error.type, "iMessage Error");

    assert.equal((await request("POST", legacyPath, { password: null })).status, 401);
    assert.equal(await receiptCount(), before);
});

test("receipt endpoints never log raw chat GUIDs", async () => {
    helper.mode = "writeError";
    const ambiguous = await submit({ chatGuid: CHAT, attemptId: attempt("logAmbiguous") });
    assert.equal(ambiguous.status, 200);
    assert.equal(ambiguous.json.data.state, "pending");
    assert.equal((await submit({ chatGuid: OTHER_CHAT, attemptId: attempt("logAmbiguous") })).status, 409);

    assert.ok(
        logLines.some(line => line.includes("Request to /api/v1/chat/delete/recoverable/attempts")),
        "request log"
    );
    assert.ok(
        logLines.some(line => line.includes("unknown outcome; leaving it pending")),
        "outcome log"
    );
    // The legacy route carries the GUID in its URL, so its pre-existing request/metrics logs are exempt
    const legacyPath = `/api/v1/chat/${encodeURIComponent(CHAT)}/delete/recoverable `;
    const receiptLines = logLines.filter(line => !line.includes(legacyPath));
    assert.ok(receiptLines.length < logLines.length, "legacy exemption should match something");
    for (const line of receiptLines) {
        assert.ok(!line.includes(CHAT) && !line.includes(OTHER_CHAT), line);
        assert.ok(!line.includes(encodeURIComponent(CHAT)), line);
    }
});
