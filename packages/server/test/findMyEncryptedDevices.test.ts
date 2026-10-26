import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readEncryptedDevices } from "../src/server/api/lib/findmy/FindMyEncryptedBackend";
import { CACHE_KEY, sealedCacheFile } from "./findMyCacheFixtures";

const withFindMyDir = <T>(files: Record<string, Buffer>, fn: (dir: string) => T): T => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "findmy-devices-test-"));
    try {
        for (const [name, data] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), data);
        return fn(dir);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
};

const IPHONE = { id: "device-1", name: "iPhone", deviceDisplayName: "iPhone 15", address: { label: "Home" } };
const AIRTAG = {
    identifier: "item-1",
    name: "Keys",
    productType: { type: "b389" },
    groupIdentifier: "group-1",
    address: { label: "Home" },
    location: { latitude: 33.1, longitude: -96.6 }
};
const EARBUD = { identifier: "item-2", name: "Left", productType: { type: "AirPods" }, groupIdentifier: "group-2" };
const GROUPS = [
    { identifier: "group-1", name: "Key ring" },
    { identifier: "group-2", name: "AirPods Pro" }
];

test("decrypts Devices, Items and ItemGroups and combines them like the plaintext path", () =>
    withFindMyDir(
        {
            "Devices.data": sealedCacheFile([IPHONE]),
            "Items.data": sealedCacheFile([AIRTAG, EARBUD]),
            "ItemGroups.data": sealedCacheFile(GROUPS)
        },
        dir => {
            const devices = readEncryptedDevices(CACHE_KEY, dir);

            assert.equal(devices.length, 3);
            assert.deepEqual(devices[0], IPHONE);
            assert.equal(devices[1].id, "item-1");
            assert.equal(devices[1].modelDisplayName, "AirTag");
            assert.equal(devices[1].isConsideredAccessory, true);
            assert.equal(devices[1].groupName, "Key ring");
            assert.deepEqual(devices[1].location, { latitude: 33.1, longitude: -96.6 });
            assert.equal(devices[2].groupName, "AirPods Pro");
            // Addresses pass through untouched, even when two devices share one
            assert.equal(devices[0].address.label, "Home");
            assert.equal(devices[1].address.label, "Home");
        }
    ));

test("missing Items or ItemGroups still returns the devices; nothing at all returns null", () => {
    withFindMyDir({ "Devices.data": sealedCacheFile([IPHONE]) }, dir => {
        assert.deepEqual(readEncryptedDevices(CACHE_KEY, dir), [IPHONE]);
    });
    withFindMyDir({ "Items.data": sealedCacheFile([AIRTAG]) }, dir => {
        const devices = readEncryptedDevices(CACHE_KEY, dir);
        assert.deepEqual(
            devices.map(device => [device.id, device.groupName]),
            [["item-1", undefined]]
        );
    });
    withFindMyDir({}, dir => {
        assert.equal(readEncryptedDevices(CACHE_KEY, dir), null);
    });
});

test("an Items payload that decrypts to null or a non-array is treated as no items", () =>
    withFindMyDir(
        {
            "Devices.data": sealedCacheFile([IPHONE]),
            "Items.data": sealedCacheFile({ items: "$null" }),
            "ItemGroups.data": sealedCacheFile(GROUPS)
        },
        dir => {
            assert.deepEqual(readEncryptedDevices(CACHE_KEY, dir), [IPHONE]);
        }
    ));

test("one malformed or undecryptable file degrades to the others instead of failing the list", () => {
    const wrongKey = sealedCacheFile([AIRTAG], Buffer.alloc(32, 0x33));
    const cases: Array<[string, Record<string, Buffer>, string[]]> = [
        [
            "corrupt ItemGroups",
            {
                "Devices.data": sealedCacheFile([IPHONE]),
                "Items.data": sealedCacheFile([AIRTAG]),
                "ItemGroups.data": Buffer.from("not a plist")
            },
            ["device-1", "item-1"]
        ],
        [
            "Items sealed with another key",
            { "Devices.data": sealedCacheFile([IPHONE]), "Items.data": wrongKey },
            ["device-1"]
        ],
        [
            "truncated Devices",
            { "Devices.data": sealedCacheFile([IPHONE]).subarray(0, 40), "Items.data": sealedCacheFile([AIRTAG]) },
            ["item-1"]
        ]
    ];
    for (const [name, files, expected] of cases) {
        withFindMyDir(files, dir => {
            const errors: string[] = [];
            const devices = readEncryptedDevices(CACHE_KEY, dir, (file, error) => errors.push(`${file}: ${error}`));

            assert.deepEqual(
                devices.map(device => device.id),
                expected,
                name
            );
            assert.equal(errors.length, 1, name);
        });
    }
});

test("null entries inside the decrypted Items or ItemGroups are skipped", () =>
    withFindMyDir(
        {
            "Items.data": sealedCacheFile(["$null", AIRTAG]),
            "ItemGroups.data": sealedCacheFile(["$null", GROUPS[0]])
        },
        dir => {
            const devices = readEncryptedDevices(CACHE_KEY, dir);

            assert.deepEqual(
                devices.map(device => [device.id, device.groupName]),
                [["item-1", "Key ring"]]
            );
        }
    ));
