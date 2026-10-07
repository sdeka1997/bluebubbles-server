# Custom BlueBubbles server build (local only — never push)

Production runs this tree's `packages/server/dist/main.js`, repacked into the official
v1.9.9 app bundle. Every change to this tree is a commit; nothing is a hand-tweak.

## Build
    ./build-server.sh            # Nix Node 22.23.3 / npm 10.9.9; recreates node_modules if absent

## Build-environment fixes (committed, required)
- `devEngines` removed from package.json — npm 10.9.x rejects its format ("Invalid property devEngines.node").
- `ScheduledService.ts`: `NodeJS.Timer` -> `NodeJS.Timeout` — the server pins TypeScript 5.5.2
  against @types/node 18.19.x, where clearInterval() no longer accepts `Timer`.

## Deploy (scripts mirrored on halo: ~/work/v812-deploy-audit/)
1. Copy `repack-v812N.js` and bump every version/path/hash for the next version. Its base must be the currently-live ASAR **and its adjacent `.unpacked` directory**; it swaps `main.js`/`main.js.map`, verifies 28 unpacked files + feature markers, and prints `ElectronAsarIntegrity`.
2. Run the repacker on the Air with the dependency installed by `build-server.sh`:
   ```bash
   export PATH=/nix/var/nix/profiles/default/bin:$PATH
   export NODE_PATH="$HOME/BlueBubbles-Server-Build-v812/node_modules"
   cd "$HOME/BlueBubbles-v812-Package"
   nix shell nixpkgs#nodejs_22 -c node repack-v812N.js
   ```
   A bare `node` is absent on the Air, and Nix Node cannot resolve `@electron/asar` unless `NODE_PATH` points at the rebuilt source tree.
3. On the server: `prepare-v8.12.N.sh` → `sign-v8.12.N.command` (open via GUI) → `update-watchdog-v8.12.N.sh` → install `--preflight` → install `--install`.
4. Run `verify-live-v8.12.sh`, then touch `APPROVED` and remove `ARMED`.

## Disk
`rm -rf node_modules packages/*/node_modules` after deploying. The npm cache makes reinstalling ~10 s.
