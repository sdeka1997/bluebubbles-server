# BlueBubbles reconciliation record

Last verified: 2026-10-26 (UTC). Regenerate with `scripts/reconcile.sh` (below).

## The invariant

**What runs on the Pixel and on the server == upstream + the open PRs**, except for
the private-build items listed under *Known private-only differences*. Any other
difference is a bug in this record or a piece of lost work, and should be treated
as such.

## Deployed builds

| Target | Version | Commit | Fork branch |
|---|---|---|---|
| Pixel 10 (`com.bluebubbles.messaging.alpha`) | 2.1.2-daily.51 (code 60006142) | `85edcd6ce` (docs commit on top: `257632d05`) | `deployed/app-daily.39-47` |
| Server (Ventura 13.7.8, custom build) | v8.12.17, asar `8d9dcf57ba5f…` | `8ebcc092` (docs commit on top: `e90ebb1f`) | `deployed/server-v8.12.17` |

Earlier deployed states are kept as `deployed/server-v8.12.13` … `v8.12.16`.

## Open PRs and their heads at verification time

| PR | Branch | Head |
|---|---|---|
| app #3309 read sync + chat delete + message delete/restore | `feat/apple-read-and-delete-sync` | `f3a8064d1` |
| app #3378 Spam folder + backfill | `pub/chat-spam-list` | `a9b1314e8` |
| app #3306 Find My | `fix/findmy-list-order-and-inset` | `5a2a6cbfc` |
| app #3370 multi-select tile reuse | `fix/conversation-tile-select-reuse` | `1c1b24576` |
| server #856 read sync + message delete | `feat/apple-read-and-delete-sync` | `553d998d` |
| server #874 Spam flag | `pub/chat-spam-flag` | `0656dd98` |
| server #872 FCM 4 KB + read priority | `fix/fcm-4kb-and-read-priority` | `11425a90` |
| server #871 TS2769 | `fix/scheduledservice-timeout-type` | `986c6bc1` |
| server #855 Find My SecureLocationCache | `feat/findmy-securelocationcache-refresh` | `4993fde1` |
| server #854 Unicode filenames | `fix/unicode-attachment-filenames` | `8c210e9c` |
| server #875 migration name (filed 2026-10-26) | `fix/migration-name-minified` | `c452dd23` |

## Known private-only differences (deliberate; never to be filed)

**App** (`daily/39` vs upstream + 4 PRs, source tree, ignoring whitespace):
- `settings_service.dart` + its test: Android update check ignores desktop releases.
  Filed as #3369, closed as duplicate of upstream #3335 — upstream now carries an
  equivalent inline check. Private build keeps the extracted helper + test.
- `shared_preferences_database_actions.dart`: a 4-line doc comment differs.
- `findmy_*` widgets, `sync_service.dart`: formatter line-wrapping only.
- `method_channel_handlers_test.dart`: `_FakeDelegate({this.headless = true})` vs
  `required` — test-fixture default only.

**Server** (`custom-v8.12.17` vs development + 6 PRs, source tree):
- `updateService/customBuildPolicy.ts` + `updateService/index.ts` + the
  `serverRouter.ts` guard: disables the official update checker so the custom
  build never self-replaces. Marker string `CUSTOM_BUILD_UPDATE_DISABLED`.
- Review-driven version gates present on PRs but not yet on the deployed build
  (no effect on Ventura): `supportsChatStateSnapshot` (#856),
  `supportsSecureLocationCacheReader` (#855). Next server build should start
  from `development + PRs` so these land.
- `index.ts`: the read-status listener block sits at a different position
  (same code).
- Binary daemons/dylibs/icons under `appResources/`: upstream commits them,
  the custom line sources them from the official app bundle at install time.

## Build-line facts that bit us

- **The custom server line is a separate git root** (`98771d3d`, "custom server
  v8.12.3"), not a branch of upstream. Commit-hash comparisons against PRs are
  meaningless; compare by patch content (`git patch-id`) or by merged tree.
- **The app private line keeps original commits; PRs got squashed rewrites.**
  Same caveat: 3-commit series on the phone vs 1-commit squash on the PR will not
  match by patch-id. The merged-tree diff is the only trustworthy test.
- **Never trust `origin/<branch>` without checking the fetch refspec.** The app
  checkout's `remote.origin.fetch` was narrowed to one branch until 2026-10-25,
  freezing every other remote-tracking ref for days. Fixed; the reconcile script
  reads tips from the GitHub API, not from remote-tracking refs.

## Superseded local branches / worktrees (safe to delete; nothing unique)

App: `pub/message-delete-sync` (worktree `experiments/app-msgdel`),
`pub/pr3309-trim` (`experiments/pr3309-trim`), `clean/pr3309`, `append/pr3309`
(= current PR head), the `source/` worktree on a stale
`feat/apple-read-and-delete-sync` at `279d2b91e` (content is on the PR as
`5d196672b`). Server: `clean/pr856`, `pub/pr856-v4`, `fix/pr8*` working branches
(all pushed to their PR branches).

## How to re-verify

```
# on the Air
~/BlueBubbles-Alpha-Build/scripts/reconcile.sh
```
It prints, for app and server: deployed commit vs fork `deployed/*` branch, each
PR's GitHub head vs fork tip, and the merged-tree diff of the deployed build
against upstream + all open PRs. Anything not listed under *Known private-only
differences* above is a finding.
