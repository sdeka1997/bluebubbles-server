import { spawn } from "child_process";
import { FindMyLocationItem } from "./types";

export type ApplePlacemark = {
    name?: string | null;
    thoroughfare?: string | null;
    subThoroughfare?: string | null;
    locality?: string | null;
    subLocality?: string | null;
    administrativeArea?: string | null;
    subAdministrativeArea?: string | null;
    postalCode?: string | null;
    country?: string | null;
};

export type PlacemarkLabels = {
    /** City-level caption, used for collapsed rows and map pins. */
    short: string;
    /** Street address when Apple supplies one, matching what device and item rows show. */
    long: string;
};

export type ReverseGeocodeRunner = (latitude: number, longitude: number) => Promise<ApplePlacemark>;

type ResolverOptions = {
    failureBackoffMs?: number;
    maxCachedCells?: number;
};

const DEFAULT_FAILURE_BACKOFF_MS = 10 * 60 * 1000;
const DEFAULT_MAX_CACHED_CELLS = 1000;
const MAX_HELPER_OUTPUT_BYTES = 16 * 1024;
const HELPER_TIMEOUT_MS = 20 * 1000;

const cleanPart = (value?: string | null): string | null => {
    const normalized = value?.trim();
    return normalized ? normalized : null;
};

export const formatPlacemarkLabel = (placemark: ApplePlacemark): string | null => {
    const locality = cleanPart(placemark.locality);
    const administrativeArea = cleanPart(placemark.administrativeArea);
    const country = cleanPart(placemark.country);

    if (locality && administrativeArea) return `${locality}, ${administrativeArea}`;
    return locality ?? administrativeArea ?? country;
};

// Apple's own Find My rows show a street address, so prefer the street parts and fall back
// through progressively coarser placemark fields. `name` is Apple's own formatted label for
// the coordinate (often already the street address), so it wins when a street is present.
const formatStreetAddress = (placemark: ApplePlacemark): string | null => {
    const subThoroughfare = cleanPart(placemark.subThoroughfare);
    const thoroughfare = cleanPart(placemark.thoroughfare);
    const name = cleanPart(placemark.name);

    if (thoroughfare) {
        const street = subThoroughfare ? `${subThoroughfare} ${thoroughfare}` : thoroughfare;
        // `name` repeats the street for most addresses; keep the richer of the two.
        return name && name.includes(thoroughfare) ? name : street;
    }

    // No street: `name` may still hold a venue or landmark, which beats a bare city.
    return name ?? cleanPart(placemark.subLocality);
};

export const formatPlacemarkLabels = (placemark: ApplePlacemark): PlacemarkLabels | null => {
    const short = formatPlacemarkLabel(placemark);
    if (!short) return null;

    const street = formatStreetAddress(placemark);
    // Never return a long form that is just the short one repeated with no added detail.
    return { short, long: street && street !== short ? street : short };
};

const hasUsableCoordinates = (item: FindMyLocationItem): boolean => {
    const [latitude, longitude] = item.coordinates ?? [];
    return (
        Number.isFinite(latitude) &&
        Number.isFinite(longitude) &&
        Math.abs(latitude) <= 90 &&
        Math.abs(longitude) <= 180 &&
        (latitude !== 0 || longitude !== 0)
    );
};

const hasNeutralAddress = (item: FindMyLocationItem): boolean => {
    const labels = [item.short_address, item.long_address]
        .map(label => label?.trim())
        .filter((label): label is string => Boolean(label));
    return labels.length === 0 || labels.every(label => label === "Location" || label === "$null");
};

// Three decimal places are roughly a 100 m cell. This avoids repeatedly geocoding GPS
// jitter while retaining enough precision for people close to a city boundary. The key
// exists only in memory; decrypted coordinates are never written to disk.
const coordinateCell = (item: FindMyLocationItem): string =>
    `${item.coordinates[0].toFixed(3)},${item.coordinates[1].toFixed(3)}`;

export class FindMyAddressResolver {
    private readonly labels = new Map<string, PlacemarkLabels>();
    private readonly handleLabels = new Map<string, PlacemarkLabels>();
    private readonly pending = new Set<string>();
    private readonly failedUntil = new Map<string, number>();
    private readonly failureBackoffMs: number;
    private readonly maxCachedCells: number;
    private queue: Promise<void> = Promise.resolve();

    constructor(private readonly runner: ReverseGeocodeRunner, options: ResolverOptions = {}) {
        this.failureBackoffMs = options.failureBackoffMs ?? DEFAULT_FAILURE_BACKOFF_MS;
        this.maxCachedCells = options.maxCachedCells ?? DEFAULT_MAX_CACHED_CELLS;
    }

    applyCachedLabels(locations: FindMyLocationItem[]): FindMyLocationItem[] {
        return locations.map(item => {
            if (!hasNeutralAddress(item) || !hasUsableCoordinates(item)) return item;
            const labels = this.handleLabels.get(item.handle) ?? this.labels.get(coordinateCell(item));
            return labels ? { ...item, short_address: labels.short, long_address: labels.long } : item;
        });
    }

    resolveMissingLabels(
        locations: FindMyLocationItem[],
        onResolved: (item: FindMyLocationItem, labels: PlacemarkLabels) => void | Promise<void>,
        onError: (error: unknown) => void = () => undefined
    ): void {
        for (const item of locations) {
            if (!hasNeutralAddress(item) || !hasUsableCoordinates(item)) continue;

            const cell = coordinateCell(item);
            if (this.labels.has(cell) || this.pending.has(cell) || (this.failedUntil.get(cell) ?? 0) > Date.now()) {
                continue;
            }

            this.pending.add(cell);
            this.queue = this.queue.then(async () => {
                try {
                    const placemark = await this.runner(item.coordinates[0], item.coordinates[1]);
                    const labels = formatPlacemarkLabels(placemark);
                    if (!labels) throw new Error("Apple reverse geocoder returned no displayable locality");

                    this.labels.set(cell, labels);
                    if (item.handle) this.handleLabels.set(item.handle, labels);
                    this.failedUntil.delete(cell);
                    while (this.labels.size > this.maxCachedCells) {
                        this.labels.delete(this.labels.keys().next().value);
                    }
                    await onResolved(item, labels);
                } catch (error) {
                    this.failedUntil.set(cell, Date.now() + this.failureBackoffMs);
                    onError(error);
                } finally {
                    this.pending.delete(cell);
                }
            });
        }
    }

    whenIdle(): Promise<void> {
        return this.queue;
    }
}

export const createAppleReverseGeocodeRunner =
    (binaryPath: string): ReverseGeocodeRunner =>
    (latitude, longitude) =>
        new Promise<ApplePlacemark>((resolve, reject) => {
            const child = spawn(binaryPath, [], { stdio: ["pipe", "pipe", "ignore"] });
            let output = "";
            let settled = false;

            const finish = (error?: Error, placemark?: ApplePlacemark) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                error ? reject(error) : resolve(placemark ?? {});
            };

            const timeout = setTimeout(() => {
                child.kill("SIGKILL");
                finish(new Error("Apple reverse geocoder timed out"));
            }, HELPER_TIMEOUT_MS);

            child.once("error", () => finish(new Error("Failed to start Apple reverse geocoder")));
            child.stdout.setEncoding("utf8");
            child.stdout.on("data", chunk => {
                output += chunk;
                if (Buffer.byteLength(output) > MAX_HELPER_OUTPUT_BYTES) {
                    child.kill("SIGKILL");
                    finish(new Error("Apple reverse geocoder returned too much data"));
                }
            });
            child.once("close", code => {
                if (settled) return;
                if (code !== 0) return finish(new Error(`Apple reverse geocoder exited with status ${code}`));

                try {
                    const result = JSON.parse(output) as ApplePlacemark & { error?: unknown };
                    if (!result || typeof result !== "object" || result.error) {
                        return finish(new Error("Apple reverse geocoder returned an error"));
                    }
                    finish(undefined, result);
                } catch {
                    finish(new Error("Apple reverse geocoder returned invalid JSON"));
                }
            });

            // Keep coordinates out of argv/process listings and never persist them.
            child.stdin.end(`${latitude} ${longitude}\n`);
        });
