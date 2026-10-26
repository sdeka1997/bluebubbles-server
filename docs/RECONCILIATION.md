# BlueBubbles reconciliation record

Last verified: 2026-10-26 (UTC). Regenerate with `docs/reconcile.sh` (below).

## The invariant

**What runs on the Pixel and on the server == upstream + the open PRs + one
private commit each.** Both deployed lines are built by merging every open PR
branch onto current upstream, then adding a single private commit. Any other
difference is lost work or a bug in this record.

## Deployed builds

| Target | Version | Commit | Fork branch |
|---|---|---|---|
| Pixel 10 (`com.bluebubbles.messaging.alpha`) | 2.1.2-daily.52 (code 60006143), APK `dd8f6c8c6312…` | tip of fork branch | `deployed/app-daily.52` |
| Server (Ventura 13.7.8, custom build) | v8.12.18, asar `9f7ec37e21a3…`, main.js `5d603a9ebe66…` | tip of fork branch | `deployed/server-v8.12.18` |

The fork branch tip is the built source plus this `docs/` folder, which is
added after the build. This record names the branch rather than a hash because
editing the record changes the hash it would name.

Previous lines are kept as `deployed/app-daily.39-47` (daily.51) and
`deployed/server-v8.12.13` … `v8.12.17`. Those were long-lived custom lines,
not rebuilt from upstream; do not build from them.

## How each line is built

App `daily/52`: `upstream/master` (`7e5f1bce5`) + merge of
#3309, #3378, #3306, #3370 + private commit.

Server `custom-v8.12.18`: `development` (`e2a5bf6e`) + merge of
#856, #874, #872, #871, #855, #854, #875 + private commit.

Next build: same recipe on the then-current upstream and PR heads. Never
cherry-pick onto the previous deployed line.

## Open PRs and their heads at verification time

| PR | Branch | Head |
|---|---|---|
| app #3309 read sync + chat delete + message delete/restore | `feat/apple-read-and-delete-sync` | `bae7ac193` |
| app #3378 Spam folder + backfill | `pub/chat-spam-list` | `a07f1bb1f` |
| app #3306 Find My | `fix/findmy-list-order-and-inset` | `5a2a6cbfc` |
| app #3370 multi-select tile reuse | `fix/conversation-tile-select-reuse` | `1c1b24576` |
| server #856 read sync + message delete | `feat/apple-read-and-delete-sync` | `68b203bd` |
| server #874 Spam flag | `pub/chat-spam-flag` | `0656dd98` |
| server #872 FCM 4 KB + read priority | `fix/fcm-4kb-and-read-priority` | `11425a90` |
| server #871 TS2769 | `fix/scheduledservice-timeout-type` | `986c6bc1` |
| server #855 Find My SecureLocationCache | `feat/findmy-securelocationcache-refresh` | `4993fde1` |
| server #854 Unicode filenames | `fix/unicode-attachment-filenames` | `8c210e9c` |
| server #875 migration name | `fix/migration-name-minified` | `c452dd23` |

## Known private-only differences (deliberate; never to be filed)

**App** — the private commit only:
- `android/app/build.gradle`: alpha launcher name "BlueBubbles+".
- `LOCAL-BUILD.md`: local build notes.
- `docs/`: this record and the reconcile script.

**Server** — the private commit only:
- `updateService/customBuildPolicy.ts`, `updateService/index.ts`, and the
  `serverRouter.ts` `installUpdate` guard: disable the official update checker
  so the custom build never self-replaces. Marker `CUSTOM_BUILD_UPDATE_DISABLED`.
- `package.json`: `devEngines` removed (npm 10.9 rejects it).
- `.gitignore`, `build-server.sh`, `BUILD-README.md`, `docs/`: local build.
- Binary daemons/dylibs/icons under `appResources/` are upstream's; the
  geocoder ships rebuilt (`findmy-geocoder` sha256 `4937cd10626a…`).

## Build-line facts that bit us

- **The pre-v8.12.18 server line was a separate git root** (`98771d3d`), so
  commit comparisons against PRs were meaningless and drift went unnoticed.
  v8.12.18 onward is built on `development` and shares its history.
- **Squashed PR commits do not patch-id-match an original series.** The
  merged-tree diff is the only trustworthy test.
- **Never trust `origin/<branch>` without checking the fetch refspec.** The
  reconcile script reads tips from the GitHub API.

## How to re-verify

```
# on the Air
~/BlueBubbles-Alpha-Build/scripts/reconcile.sh
```
It prints, for app and server: deployed commit vs fork `deployed/*` branch,
each PR's GitHub head vs fork tip, and the merged-tree diff of the deployed
build against upstream + all open PRs. Anything not listed under *Known
private-only differences* is a finding.
