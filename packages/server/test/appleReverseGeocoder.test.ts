import assert from "node:assert/strict";
import test from "node:test";

import {
    FindMyAddressResolver,
    formatPlacemarkLabel,
    formatPlacemarkLabels,
    type ReverseGeocodeRunner
} from "../src/server/api/lib/findmy/AppleReverseGeocoder";
import { FindMyLocationItem } from "../src/server/api/lib/findmy/types";

const location = (overrides: Partial<FindMyLocationItem> = {}): FindMyLocationItem => ({
    handle: "friend@example.com",
    coordinates: [33.0198, -96.6989],
    long_address: "Location",
    short_address: "Location",
    subtitle: null,
    title: "Friend",
    last_updated: Date.UTC(2026, 9, 4, 7, 0, 0),
    is_locating_in_progress: false,
    status: "shallow",
    ...overrides
});

test("formats a useful short locality label with bounded fallbacks", () => {
    assert.equal(
        formatPlacemarkLabel({ locality: "Plano", administrativeArea: "TX", country: "United States" }),
        "Plano, TX"
    );
    assert.equal(formatPlacemarkLabel({ locality: "Paris", country: "France" }), "Paris");
    assert.equal(formatPlacemarkLabel({ administrativeArea: "Texas", country: "United States" }), "Texas");
    assert.equal(formatPlacemarkLabel({ country: "United States" }), "United States");
    assert.equal(formatPlacemarkLabel({}), null);
});

test("splits street-level long labels from city-level short labels", () => {
    // A full street address: short stays city-level, long carries the street.
    assert.deepEqual(
        formatPlacemarkLabels({
            name: "1200 E Spring Creek Pkwy",
            subThoroughfare: "1200",
            thoroughfare: "E Spring Creek Pkwy",
            locality: "Plano",
            administrativeArea: "TX",
            country: "United States"
        }),
        { short: "Plano, TX", long: "1200 E Spring Creek Pkwy" }
    );

    // Street with no house number still beats a bare city.
    assert.deepEqual(
        formatPlacemarkLabels({
            thoroughfare: "Karlova",
            locality: "Prague 1",
            administrativeArea: "Prague",
            country: "Czechia"
        }),
        { short: "Prague 1, Prague", long: "Karlova" }
    );

    // No street at all: fall back to the short label rather than inventing detail.
    assert.deepEqual(formatPlacemarkLabels({ locality: "Plano", administrativeArea: "TX" }), {
        short: "Plano, TX",
        long: "Plano, TX"
    });

    // A venue name with no thoroughfare is still richer than the city.
    assert.deepEqual(
        formatPlacemarkLabels({ name: "Dallas Love Field", locality: "Dallas", administrativeArea: "TX" }),
        { short: "Dallas, TX", long: "Dallas Love Field" }
    );

    assert.equal(formatPlacemarkLabels({}), null);
});

test("resolves neutral labels in the background and reuses an in-memory coordinate-cell cache", async () => {
    const calls: Array<[number, number]> = [];
    const runner: ReverseGeocodeRunner = async (latitude, longitude) => {
        calls.push([latitude, longitude]);
        return {
            name: "1200 E Spring Creek Pkwy",
            subThoroughfare: "1200",
            thoroughfare: "E Spring Creek Pkwy",
            locality: "Plano",
            administrativeArea: "TX",
            country: "United States"
        };
    };
    const resolver = new FindMyAddressResolver(runner);
    const updates: Array<{ handle: string; short: string; long: string }> = [];
    const input = location();

    assert.equal(resolver.applyCachedLabels([input])[0].short_address, "Location");
    resolver.resolveMissingLabels([input], (item, labels) => {
        updates.push({ handle: item.handle!, short: labels.short, long: labels.long });
    });
    await resolver.whenIdle();

    assert.deepEqual(calls, [[33.0198, -96.6989]]);
    assert.deepEqual(updates, [
        { handle: "friend@example.com", short: "Plano, TX", long: "1200 E Spring Creek Pkwy" }
    ]);
    assert.equal(resolver.applyCachedLabels([input])[0].short_address, "Plano, TX");
    assert.equal(resolver.applyCachedLabels([input])[0].long_address, "1200 E Spring Creek Pkwy");

    resolver.resolveMissingLabels([location({ coordinates: [33.01981, -96.69891] })], () => undefined);
    await resolver.whenIdle();
    assert.equal(calls.length, 1, "nearby coordinates should reuse the same in-memory cache cell");
});

test("preserves real Apple labels and never sends unusable coordinates to the geocoder", async () => {
    let calls = 0;
    const runner: ReverseGeocodeRunner = async () => {
        calls += 1;
        return { locality: "Unexpected" };
    };
    const resolver = new FindMyAddressResolver(runner);
    const home = location({ short_address: "Home", long_address: "Home" });
    const noFix = location({ handle: "no-fix", coordinates: [0, 0] });
    const invalid = location({ handle: "invalid", coordinates: [Number.NaN, -96] });

    resolver.resolveMissingLabels([home, noFix, invalid], () => undefined);
    await resolver.whenIdle();

    assert.equal(calls, 0);
    assert.equal(resolver.applyCachedLabels([home])[0].short_address, "Home");
});

test("keeps a friend's last label when their coordinates shift, instead of flashing back to Location", async () => {
    const calls: Array<[number, number]> = [];
    const runner: ReverseGeocodeRunner = async (latitude, longitude) => {
        calls.push([latitude, longitude]);
        return { locality: "Plano", administrativeArea: "TX", country: "United States" };
    };
    const resolver = new FindMyAddressResolver(runner);

    resolver.resolveMissingLabels([location()], () => undefined);
    await resolver.whenIdle();
    assert.deepEqual(calls, [[33.0198, -96.6989]]);

    // Same friend, new coordinate cell. The last known label must survive until
    // the new cell is reverse-geocoded, rather than falling back to "Location".
    const moved = location({ coordinates: [34.0522, -118.2437] });
    const cached = resolver.applyCachedLabels([moved])[0];
    assert.equal(cached.short_address, "Plano, TX");
    assert.equal(cached.long_address, "Plano, TX");
});

test("backs off failed cells instead of retrying them on every refresh", async () => {
    let calls = 0;
    const runner: ReverseGeocodeRunner = async () => {
        calls += 1;
        throw new Error("unavailable");
    };
    const resolver = new FindMyAddressResolver(runner, { failureBackoffMs: 10 * 60 * 1000 });
    const errors: string[] = [];

    resolver.resolveMissingLabels(
        [location()],
        () => undefined,
        error => errors.push(String(error))
    );
    await resolver.whenIdle();
    resolver.resolveMissingLabels(
        [location()],
        () => undefined,
        error => errors.push(String(error))
    );
    await resolver.whenIdle();

    assert.equal(calls, 1);
    assert.equal(errors.length, 1);
});
