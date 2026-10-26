import assert from "node:assert/strict";
import test from "node:test";

import { buildFindMyRoster, normalizeFindMyHandle } from "../src/server/api/lib/findmy/FindMyFriendRoster";

const fixture = {
    myInfo: { emails: ["owner@example.com"] },
    contacts: {
        "person-dad": { displayName: "Dad" },
        "person-may": { displayName: "May" },
        "person-phone": { displayName: "Phone Friend" }
    },
    following: [
        {
            id: "person-dad",
            invitationAcceptedHandles: ["dad-current@example.com"],
            invitationFromHandles: ["owner@example.com"]
        },
        {
            id: "person-may",
            invitationAcceptedHandles: ["may-current@example.com"],
            invitationFromHandles: ["owner@example.com"]
        },
        {
            id: "person-phone",
            invitationAcceptedHandles: ["+1 (555) 555-0123"],
            invitationFromHandles: ["owner@example.com"]
        }
    ],
    followers: [
        {
            id: "person-dad",
            invitationAcceptedHandles: ["owner@example.com"],
            invitationFromHandles: ["dad-old@example.edu"]
        },
        {
            id: "person-may",
            invitationAcceptedHandles: ["owner@example.com"],
            invitationFromHandles: ["+186****2782"]
        },
        {
            id: "person-phone",
            invitationAcceptedHandles: ["owner@example.com"],
            invitationFromHandles: ["+15555550123"]
        }
    ],
    preferences: { favorites: [{ id: "person-may", order: 1 }, { id: "person-dad", order: 0 }] }
};

test("builds one authoritative identity from all of a friend's Apple handles", () => {
    const roster = buildFindMyRoster(fixture)!;

    assert.equal(roster.primaryHandles.get("person-dad"), "dad-current@example.com");
    assert.equal(roster.aliases.get("dad-current@example.com"), "person-dad");
    assert.equal(roster.aliases.get("dad-old@example.edu"), "person-dad");
    assert.equal(roster.aliases.get(normalizeFindMyHandle("+186****2782")), "person-may");
    assert.equal(roster.names.get("person-dad"), "Dad");
    assert.deepEqual([...roster.favorites], [["person-may", 1], ["person-dad", 0]]);
});

test("normalizes formatting variants of the same phone number", () => {
    assert.equal(normalizeFindMyHandle("+1 (555) 555-0123"), normalizeFindMyHandle("+15555550123"));
    const roster = buildFindMyRoster(fixture)!;
    assert.equal(roster.aliases.get(normalizeFindMyHandle("+15555550123")), "person-phone");
});

test("never treats the owner's address as a friend's alias", () => {
    const roster = buildFindMyRoster(fixture)!;
    assert.equal(roster.aliases.has("owner@example.com"), false);
});

test("drops an ambiguous handle instead of merging two people", () => {
    const data = structuredClone(fixture);
    data.followers[1].invitationFromHandles = ["shared@example.com"];
    data.followers[2].invitationFromHandles = ["shared@example.com"];
    const roster = buildFindMyRoster(data)!;
    assert.equal(roster.aliases.has("shared@example.com"), false);
});

test("returns null when Apple has no authoritative following list", () => {
    assert.equal(buildFindMyRoster({ contacts: {} }), null);
});

// macOS 14.4+ encrypts FriendCacheData.data. PR #810 decrypts it to a plist whose
// friend ids carry trailing "~" padding (it strips them before use).
const pad = (id: string): string => `${id}~~`;
const encryptedFixture = () => {
    const data: any = structuredClone(fixture);
    data.contacts = Object.fromEntries(Object.entries(data.contacts).map(([id, contact]) => [pad(id), contact]));
    for (const friend of [...data.following, ...data.followers]) friend.id = pad(friend.id);
    for (const favorite of data.preferences.favorites) favorite.id = pad(favorite.id);
    return data;
};

test("decrypted FMF payload with padded ids builds the same roster as the plaintext file", () => {
    assert.deepEqual(buildFindMyRoster(encryptedFixture()), buildFindMyRoster(fixture));
});

test("decrypted FMF payload keeps aliases, favorites, owner exclusion, and ambiguity rules", () => {
    const data = encryptedFixture();
    data.followers[1].invitationFromHandles = ["shared@example.com"];
    data.followers[2].invitationFromHandles = ["shared@example.com"];
    const roster = buildFindMyRoster(data)!;

    assert.equal(roster.aliases.get("dad-old@example.edu"), "person-dad");
    assert.equal(roster.aliases.has("owner@example.com"), false);
    assert.equal(roster.aliases.has("shared@example.com"), false);
    assert.deepEqual([...roster.favorites], [["person-may", 1], ["person-dad", 0]]);
    assert.equal(roster.names.get("person-phone"), "Phone Friend");
});

test("Apple's \"$null\" plist placeholder never becomes a handle or a name", () => {
    const data = encryptedFixture();
    data.following.push({
        id: pad("person-pending"),
        invitationAcceptedHandles: ["$null"],
        invitationFromHandle: "$null",
        invitationSentToHandle: "pending@example.com"
    });
    data.contacts[pad("person-pending")] = { displayName: "$null", shortName: "Pending" };
    const roster = buildFindMyRoster(data)!;

    assert.equal(roster.primaryHandles.get("person-pending"), "pending@example.com");
    assert.equal(roster.aliases.has("$null"), false);
    assert.equal(roster.names.get("person-pending"), "Pending");
});
