import assert from "node:assert/strict";
import test from "node:test";

import {
    isValidReaction,
    serializeAssociatedReaction,
    toHelperReaction
} from "../src/server/api/reactions";
import { MessageTypeTransformer } from "../src/server/databases/transformers/MessageTypeTransformer";

const standardReactions = [
    "love",
    "like",
    "dislike",
    "laugh",
    "emphasize",
    "question",
    "-love",
    "-like",
    "-dislike",
    "-laugh",
    "-emphasize",
    "-question"
];

test("standard reactions remain valid before Sequoia", () => {
    for (const reaction of standardReactions) {
        assert.equal(isValidReaction(reaction, false), true, reaction);
    }
});

test("one emoji grapheme and its removal are valid on Sequoia", () => {
    for (const reaction of ["👍", "-👍", "👨‍👩‍👧‍👦", "-🇺🇸", "1️⃣"]) {
        assert.equal(isValidReaction(reaction, true), true, reaction);
    }
});

test("custom emoji reactions are rejected before Sequoia", () => {
    assert.equal(isValidReaction("👍", false), false);
    assert.equal(isValidReaction("-👍", false), false);
});

test("blank, arbitrary text, and oversized reactions are invalid", () => {
    const oversizedSingleGrapheme = `👩${"‍👩".repeat(32)}`;
    for (const reaction of [
        "",
        " ",
        "hello",
        "-hello",
        "👍👍",
        "-👍👍",
        "🙂x",
        "-",
        "👍".repeat(100),
        oversizedSingleGrapheme
    ]) {
        assert.equal(isValidReaction(reaction, true), false, JSON.stringify(reaction));
    }
});

test("helper payload preserves standard reactions", () => {
    assert.deepEqual(toHelperReaction("love"), { reactionType: "love" });
    assert.deepEqual(toHelperReaction("-question"), { reactionType: "-question" });
});

test("helper payload maps emoji additions and removals", () => {
    assert.deepEqual(toHelperReaction("🥳"), { reactionType: "emoji", reactionEmoji: "🥳" });
    assert.deepEqual(toHelperReaction("-🥳"), { reactionType: "-emoji", reactionEmoji: "🥳" });
});

test("emoji reaction serialization maps additions and removals", () => {
    assert.equal(serializeAssociatedReaction("emoji", "🔥"), "🔥");
    assert.equal(serializeAssociatedReaction("-emoji", "🔥"), "-🔥");
    assert.equal(serializeAssociatedReaction("3006", "🔥"), "-🔥");
    assert.equal(serializeAssociatedReaction("like", null), "like");
});

test("message type transformer handles emoji additions and removals", () => {
    assert.equal(MessageTypeTransformer.from(2006), "emoji");
    assert.equal(MessageTypeTransformer.from(3006), "-emoji");
    assert.equal(MessageTypeTransformer.to("emoji"), 2006);
    assert.equal(MessageTypeTransformer.to("-emoji"), 3006);
});
