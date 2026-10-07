// Official updater packages do not contain this private deployment's read-sync
// and direct Find My changes. Installing one would silently remove both fixes.
export const CUSTOM_BUILD_ID: string | null = "swapnav/readsync-findmy-v812";

export const OFFICIAL_UPDATES_ENABLED = CUSTOM_BUILD_ID === null;

export const officialUpdateDisabledMessage = (): string =>
    `Official one-click updates are disabled for custom build ${CUSTOM_BUILD_ID}. ` +
    "An official release must be merged into this branch and pass a manual rebuild before installation.";
