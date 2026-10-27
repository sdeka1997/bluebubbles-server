import { FindMyRoster, stripFindMyIdPadding } from "./FindMyFriendRoster";
import { coordinateLabel, locationLabelForDisplay } from "./SecureLocationReader";
import { FindMyLocationItem } from "./types";

/** One `secureLocations` row from the decrypted macOS 14.4+ LocalStorage.db. */
export type EncryptedFriendLocation = {
    findMyId: string;
    location: Record<string, any>;
};

// (0, 0) is Apple's "no fix" sentinel. FindMyFriendsCache only refuses to let it
// overwrite a known location when both rows are "legacy", so drop it here.
const isRealFix = (latitude: unknown, longitude: unknown): boolean =>
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    Math.abs(latitude as number) <= 90 &&
    Math.abs(longitude as number) <= 180 &&
    (latitude !== 0 || longitude !== 0);

/**
 * PR #810 found the plist timestamp as a Date, epoch seconds, or epoch milliseconds.
 * Clients expect epoch milliseconds. Returns null when there is no usable time: the
 * cache orders updates by it, and NaN compares false against everything.
 */
const epochMs = (timestamp: unknown): number | null => {
    const value = timestamp instanceof Date ? timestamp.getTime() : timestamp;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
    return timestamp instanceof Date || value > 1e12 ? value : Math.round(value * 1000);
};

/**
 * Maps decrypted friend locations to the client payload, keyed by the roster's
 * primary handle so they merge with every other source of the same friend.
 */
export const buildEncryptedFriendItems = (
    rawLocations: EncryptedFriendLocation[],
    roster: FindMyRoster
): FindMyLocationItem[] => {
    const output: FindMyLocationItem[] = [];
    for (const raw of rawLocations) {
        const id = stripFindMyIdPadding(raw.findMyId);
        // PR #810 emits handle: null for friends it cannot resolve; the cache rejects those,
        // and Apple's opaque id would show up as a phantom friend, so skip them here.
        const handle = roster.primaryHandles.get(id);
        if (!handle || !raw.location || typeof raw.location !== "object") continue;
        const { latitude, longitude, timestamp, locationLabel } = raw.location;
        const lastUpdated = epochMs(timestamp);
        if (!isRealFix(latitude, longitude) || lastUpdated === null) continue;
        const coordinates: [number, number] = [latitude, longitude];
        // Keep Apple's own label (Home, Work). Otherwise show the coordinates, which
        // FindMyAddressLabeler recognises and replaces with a reverse-geocoded address.
        const label =
            (typeof locationLabel === "string" ? locationLabelForDisplay(locationLabel) : null) ??
            coordinateLabel(coordinates);

        output.push({
            handle,
            coordinates,
            long_address: label,
            short_address: label,
            subtitle: null,
            title: roster.names.get(id) ?? handle,
            last_updated: lastUpdated,
            is_locating_in_progress: false,
            status: "shallow"
        });
    }
    return output;
};
