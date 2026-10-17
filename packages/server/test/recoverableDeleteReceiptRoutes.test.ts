import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("authenticated submit and status routes expose receipt protocol", () => {
    const routes = source("../src/server/api/http/api/v1/httpRoutes.ts");
    assert.match(routes, /path: ":guid\/delete\/recoverable"[\s\S]*controller: ChatRouter\.recoverableDeleteChat/u);
    assert.match(
        routes,
        /method: HttpMethod\.GET,\s*path: ":guid\/delete\/recoverable\/:attemptId"[\s\S]*controller: ChatRouter\.recoverableDeleteStatus/u
    );
    assert.match(
        routes,
        /path: ":guid\/delete\/recoverable\/:attemptId",\s*middleware: \[\.\.\.HttpRoutes\.protected, PrivateApiMiddleware\],\s*controller: ChatRouter\.recoverableDeleteStatus/u
    );
});

test("controllers submit and look up by attempt id without returning chat binding", () => {
    const router = source("../src/server/api/http/api/v1/routers/chatRouter.ts");
    assert.match(router, /service\(\)\.submit\(attemptId, guid\)/u);
    assert.match(router, /service\(\)\.status\(attemptId, guid\)/u);
    assert.match(router, /publicReceipt/u);
    assert.doesNotMatch(router, /data:\s*receipt/u);
});

test("config database registers durable receipt entity and migration", () => {
    const database = source("../src/server/databases/server/index.ts");
    assert.match(database, /RecoverableDeleteReceiptEntity/u);
    assert.match(database, /RecoverableDeleteReceiptTable1760716800000/u);
    assert.match(database, /recoverableDeleteReceipts/u);
});
