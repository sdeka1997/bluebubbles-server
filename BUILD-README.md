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
1. `repack-v8123.js` (copy + bump for the next version): base = the currently-live ASAR pulled from the
   server; swaps main.js/main.js.map; verifies 28 unpacked files + markers; prints ElectronAsarIntegrity.
2. On the server: prepare-v8.12.N.sh -> sign-v8.12.N.command (open via GUI) -> update-watchdog -> install --preflight -> install --install.
3. verify-live-v8.12.sh, then touch APPROVED / rm ARMED.

## Disk
`rm -rf node_modules packages/*/node_modules` after deploying. The npm cache makes reinstalling ~10 s.
