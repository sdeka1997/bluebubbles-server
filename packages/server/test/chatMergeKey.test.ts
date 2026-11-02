import assert from "node:assert/strict";
import test from "node:test";

import { buildAddressToContactMap, chatMergeKey, normalizeAddress } from "../src/server/api/serializers/chatMergeKey";

// Cards and handles from the real server, redacted. The family chat is three
// contacts; Bikash Moha is ONE card holding a phone number and two emails.
const FAMILY_A = "4C5136A9-29BF-4918-811E-3E575EFE7028:ABPerson";
const FAMILY_B = "CFBEB9C6-2551-4982-BBAC-B5780143BE53:ABPerson";
const FAMILY_C = "F5478A69-D13F-4D15-A71F-F4F033D28044:ABPerson";
const BIKASH = "B4412405-BA50-4D75-9543-BB9DC8286692:ABPerson";

const contacts = [
    { id: FAMILY_A, phoneNumbers: [{ address: "+12125558415" }], emails: [] },
    { id: FAMILY_B, phoneNumbers: [{ address: "+14695555133" }], emails: [] },
    { id: FAMILY_C, phoneNumbers: [{ address: "+19725556991" }], emails: [] },
    {
        id: BIKASH,
        phoneNumbers: [{ address: "+919876548808" }],
        emails: [{ address: "bikash7361@icloud.com" }, { address: "bikash7361@gmail.com" }]
    }
];

const map = buildAddressToContactMap(contacts);

test("a phone number matches its contact regardless of formatting or country code", () => {
    assert.equal(normalizeAddress("+1 (212) 555-8415"), "2125558415");
    assert.equal(normalizeAddress("2125558415"), "2125558415");
    assert.equal(normalizeAddress("12125558415"), "2125558415");
});

test("an email is matched case-insensitively", () => {
    assert.equal(normalizeAddress("  Bikash7361@iCloud.com "), "bikash7361@icloud.com");
});

test("a short code keeps all of its digits", () => {
    assert.equal(normalizeAddress("85893"), "85893");
});

test("the family chat keys the same however its group id was reissued", () => {
    // chat.db rows 35 and 2430: different group ids, same three participants.
    const row35 = chatMergeKey(["+12125558415", "+14695555133", "+19725556991"], map);
    const row2430 = chatMergeKey(["+19725556991", "+12125558415", "+14695555133"], map);
    assert.ok(row35);
    assert.equal(row35, row2430);
});

test("a chat keys the same whether a participant is reached by email or phone", () => {
    // Bikash Moha: iMessage to bikash7361@icloud.com and SMS to +91..., one card.
    assert.equal(chatMergeKey(["bikash7361@icloud.com"], map), chatMergeKey(["+919876548808"], map));
});

test("a group keys the same when one participant appears under two addresses", () => {
    // Ming Dynasty shows as one thread on 12 and 11 participants, because the
    // extra entry is another address for a member already in the chat.
    const twelve = chatMergeKey(["+12125558415", "+14695555133", "bikash7361@icloud.com", "+919876548808"], map);
    const eleven = chatMergeKey(["+12125558415", "+14695555133", "+919876548808"], map);
    assert.equal(twelve, eleven);
});

test("chats with different participants do not share a key", () => {
    const family = chatMergeKey(["+12125558415", "+14695555133", "+19725556991"], map);
    const pair = chatMergeKey(["+12125558415", "+14695555133"], map);
    assert.notEqual(family, pair);
});

test("a chat with an unknown participant is not keyed", () => {
    // Over half the chats on this server include someone who is not in Contacts.
    // Keying on the rest would risk merging two different conversations.
    assert.equal(chatMergeKey(["+12125558415", "+15555550000"], map), null);
});

test("an address claimed by two contacts identifies no one", () => {
    const shared = buildAddressToContactMap([
        { id: FAMILY_A, phoneNumbers: [{ address: "+12125550000" }], emails: [] },
        { id: FAMILY_B, phoneNumbers: [{ address: "+12125550000" }], emails: [] }
    ]);
    assert.equal(shared.get("2125550000"), undefined);
    assert.equal(chatMergeKey(["+12125550000"], shared), null);
});

test("a chat with no participants is not keyed", () => {
    assert.equal(chatMergeKey([], map), null);
    assert.equal(chatMergeKey(null, map), null);
});

test("contacts without an id or addresses are ignored", () => {
    const sparse = buildAddressToContactMap([
        { id: null, phoneNumbers: [{ address: "+12125551111" }] },
        { id: FAMILY_A, phoneNumbers: [] },
        { id: FAMILY_B, phoneNumbers: [{ address: null }], emails: [{ address: "" }] }
    ] as any);
    assert.equal(sparse.size, 0);
});

test("emailAddresses is read as well as emails", () => {
    // ContactsLib returns emailAddresses; the HTTP API returns emails.
    const lib = buildAddressToContactMap([{ id: BIKASH, emailAddresses: [{ address: "bikash7361@gmail.com" }] }]);
    assert.equal(chatMergeKey(["bikash7361@gmail.com"], lib), BIKASH);
});
