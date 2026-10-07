const asar = require("@electron/asar");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const home = process.env.HOME;
const root = path.join(home, "BlueBubbles-v812-Package");
const sourceRoot = path.join(home, "BlueBubbles-Server-Build-v812");
const base = path.join(root, "v8122-base", "app.asar");
const extractDir = path.join(root, "extracted-v8123");
const output = path.join(root, "app.custom.v8.12.3.asar");

const sha256Buffer = data => crypto.createHash("sha256").update(data).digest("hex");
const sha256File = file => sha256Buffer(fs.readFileSync(file));
const unpackedFiles = archive => asar.listPackage(archive, { isPack: true })
    .filter(entry => entry.startsWith("unpack : "))
    .map(entry => entry.slice("unpack : ".length).replace(/^\//, ""))
    .filter(entry => !asar.statFile(archive, entry).files)
    .sort();

(async () => {
    if (sha256File(base) !== "b618bc3d78034cd7eccb05b30c9a2d4d97153d50495c5604311b89448f46d2e8") {
        throw new Error("v8.12.2 base ASAR hash mismatch");
    }

    const expectedUnpacked = unpackedFiles(base);
    if (expectedUnpacked.length !== 28) throw new Error(`expected 28 unpacked files, got ${expectedUnpacked.length}`);

    fs.rmSync(extractDir, { recursive: true, force: true });
    fs.rmSync(output, { force: true });
    fs.rmSync(`${output}.unpacked`, { recursive: true, force: true });
    asar.extractAll(base, extractDir);

    for (const name of ["main.js", "main.js.map"]) {
        fs.copyFileSync(path.join(sourceRoot, "packages/server/dist", name), path.join(extractDir, "dist", name));
    }

    const unpackPattern = path.join(extractDir, `{${expectedUnpacked.join(",")}}`);
    await asar.createPackageWithOptions(extractDir, output, { unpack: unpackPattern });

    const actualUnpacked = unpackedFiles(output);
    if (JSON.stringify(actualUnpacked) !== JSON.stringify(expectedUnpacked)) {
        throw new Error("v8.12.3 unpacked-file set differs from v8.12.2");
    }

    for (const relative of actualUnpacked) {
        const stat = asar.statFile(output, relative);
        const bytes = fs.readFileSync(path.join(`${output}.unpacked`, relative));
        if (stat.size !== bytes.length) throw new Error(`size mismatch: ${relative}`);
        if (!stat.integrity || stat.integrity.hash !== sha256Buffer(bytes)) {
            throw new Error(`integrity mismatch: ${relative}`);
        }
    }

    const main = asar.extractFile(output, "dist/main.js").toString("utf8");
    for (const marker of [
        "swapnav/readsync-findmy-v812",
        "CUSTOM_BUILD_UPDATE_DISABLED",
        "BeaconStoreKey",
        "chat-deleted",
        "chat-state/snapshot",
        "filename*=UTF-8"
    ]) {
        if (!main.includes(marker)) throw new Error(`missing marker: ${marker}`);
    }

    const rawHeader = asar.getRawHeader(output);
    console.log(JSON.stringify({
        output_sha256: sha256File(output),
        electron_asar_integrity: sha256Buffer(Buffer.from(rawHeader.headerString)),
        main_sha256: sha256Buffer(asar.extractFile(output, "dist/main.js")),
        unpacked_files: actualUnpacked.length,
        markers_verified: 6
    }, null, 2));
    fs.rmSync(extractDir, { recursive: true, force: true });
})().catch(error => {
    console.error(error && error.stack ? error.stack : String(error));
    process.exit(1);
});
