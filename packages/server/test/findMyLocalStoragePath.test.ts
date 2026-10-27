import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
    localStorageDbCandidates,
    resolveLocalStorageDbPath
} from "../src/server/api/lib/findmy/localStoragePath";

const home = "/Users/me";
const darwin = "/var/folders/ab/xyz/0/";
const groupPath = "/Users/me/Library/Group Containers/group.com.apple.findmy.findmylocateagent/Library/Application Support/LocalStorage.db";
const darwinPath = "/var/folders/ab/xyz/0/com.apple.findmy.findmylocateagent/LocalStorage.db";

describe("LocalStorage.db location", () => {
    it("checks the group container (macOS 26) and the per-user Darwin dir (macOS 15)", () => {
        assert.deepEqual(localStorageDbCandidates(home, darwin), [groupPath, darwinPath]);
    });

    it("only offers the group container when the Darwin dir is unknown", () => {
        assert.deepEqual(localStorageDbCandidates(home, null), [groupPath]);
    });

    it("uses the Darwin dir copy when that is the one that exists (Sequoia)", () => {
        const exists = (p: string) => p === darwinPath;
        assert.equal(resolveLocalStorageDbPath([groupPath, darwinPath], exists), darwinPath);
    });

    it("uses the group container copy when that is the one that exists (Tahoe)", () => {
        const exists = (p: string) => p === groupPath;
        assert.equal(resolveLocalStorageDbPath([groupPath, darwinPath], exists), groupPath);
    });

    it("falls back to the first candidate before Find My has created either", () => {
        assert.equal(resolveLocalStorageDbPath([groupPath, darwinPath], () => false), groupPath);
    });
});
