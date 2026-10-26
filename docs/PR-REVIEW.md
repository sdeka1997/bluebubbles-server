# BlueBubbles PR review — decision log

**Purpose:** the running record of the PR-by-PR review Swapnav started on
2026-10-26: what each PR does, what was decided, and what is still open.
Read this first in any new session about BlueBubbles PRs. Update it in the
same turn a decision is made. Never rely on chat history for these decisions.

**Location:** `~/durable/bluebubbles-pr-review/DECISIONS.md` on halo
(canonical). A copy is committed as `docs/PR-REVIEW.md` on both forks'
`deployed/*` branches whenever builds are pushed.

**Status:** ALL REVIEWS DECIDED (2026-10-26). Nothing executed yet. Execution
waits for Swapnav's go (it force-pushes PR branches and deploys the server).

---

## Ground rules (from Swapnav)

1. **Minimum change on top of stock** that achieves the goal. Not a
   comprehensive fix of everything touched.
2. Goal scope (2026-10-20): a cleaner Android app — notifications going away,
   read status right, deletes reflected, Find My working.
3. **The iPhone is where Spam and Recently Deleted are reviewed.** Android only
   reflects them: things leave the list. No Android-side viewers.
4. **No backfills or repairs** for states that only our own earlier builds
   produced. A fresh install never hits them.
5. Stock bugs we hit get standalone PRs, unless they are tied to our work.
6. PRs must read as bug fixes, not feature work, so maintainers review them.
   (Swapnav chose to keep the Find My redesign anyway; see #3306.)
7. Locals always match upstream: deployed = upstream + open PRs + one private
   commit each side (server: update-disable + build env; app: launcher name +
   build notes).

---

## PR ledger

| PR | Repo | Topic | Decision | State |
|---|---|---|---|---|
| #874 | server | Spam flag | **Keep as is** | Approved |
| #3378 | app | Spam | **Trim**: cut Spam list UI + backfill | Approved, not executed |
| #872 | server | FCM push delivery | **Re-scope** to 4 KB stock-bug fix, simplified | Approved, not executed |
| #856 | server | Read sync + Recently Deleted | Gains #872's read-priority commit; C3 dead code cut; snapshots trimmed for C5 | Approved, not executed |
| #3309 | app | Read sync + deletes + notifications | Cut C1–C4; catch-up rebuilt minimal (C5c) | Approved, not executed |
| #3306 | app | Find My | **Keep all** (F1–F5) | Approved, no change |
| #855 | server | Find My refresh | **S4 swap**: compiled geocoder → built-in JavaScript script | Approved, not executed |
| #3370 | app | Multi-select (stock bug) | Keep as is | No change |
| #854 | server | Unicode filenames (stock bug) | Keep as is | No change |
| #871 | server | TS2769 build fix (stock bug) | Keep as is | No change |
| #875 | server | Migration name (stock bug) | Keep as is | No change |
| #3369 | app | Update check (stock bug) | Closed by upstream as duplicate of #3335 | Done |

---

## Decisions in detail

### #874 — server, spam flag: KEEP
+84 lines, 49 of them tests. Reads Apple's verdict (`SMSCategory = 1` or
`wasDetectedAsSMSSpam` in the chat's properties plist; stock's `isFiltered` is
NOT spam) and sends `isFilteredAsSpam` with every chat, including in pushes.
Already minimal.

### #3378 — app, spam: TRIM
Behaviour after: spam chats leave the main list, don't notify, and don't count
in the badge. Spam is reviewed on the iPhone.

- **Keep:** the stored flag on each chat; copying it in from server data; the
  main-list filter; no notifications; not in the badge; the rule that a missing
  flag never clears a stored one.
- **Cut:** the Spam list and all its UI (menu entries, headers, empty state, in
  all three app styles — about 140 lines across 9 files).
- **Cut:** `SpamFlagBackfill` (~125 lines + tests). Rule 4: its only job was
  a one-time catch-up for chats stored before the flag existed.
- **Accepted consequences:** "Not Spam" on the iPhone reaches the Pixel only
  when that chat next gets a message. A fresh install shows old spam until each
  sender writes again.
- **Expected size after:** about 30 lines of real code, plus generated database
  code and tests (estimate).

### #872 — server, FCM: RE-SCOPE TO A STOCK-BUG PR
Was +741 lines in 7 commits mixing three purposes.

- **Keep, simplified:** the 4 KB fix only. Stock bug: Firebase rejects pushes
  over 4096 bytes, so long messages and big-group messages never arrive by push.
  New form: if a push is too big, drop participants and heavy message fields,
  keep the chat's own fields and the full message text; if it still won't fit,
  skip that one push. Target: a few dozen lines plus a small test.
- **Move to #856:** read events at high priority (commit `24ddc3f6`). It only
  matters because #856 makes read events fire.
- **Drop:** keep-the-spam-flag-when-compacting (commit `8dac00eb`). The chat's
  fields stay whole, so the flag survives without special code.

### #3309 + #856 — read sync and deletes

Stock context: stock already has the read-event pipe (server poller emits
`chat-read-status-changed`; app handles it over socket and FCM), but it didn't
fire for iPhone reads in practice (observed Oct 4). Stock has no delete events
and no catch-up. Sizes before: #856 ~875 src + 784 test; #3309 ~1,400 lib +
677 test.

**Kept (core 1–6):** live read/unread detection and live Recently Deleted
detection on the server; in the app, applying live events, the
incoming-already-read rule, clearing the notification when you reply from
another device, and the preview fix on hide.

**Cuts (approved):**
- C1 `repairHiddenLatestMessages` (Rule 4).
- C2 saved-format migrations in both reconcilers: v2→v3 baseline, legacy
  per-server-address buckets (Rule 4).
- C3 dead code: server `loadChatReadStates` / `parseChatReadStates` /
  `buildChatReadStatesQuery` (no callers) + their tests; app
  `setChatArchivedFromServer` (no callers) and the unused `isArchived` field
  in the server snapshot.
- C4 deferring an Apple chat deletion while the Pixel has a draft or unsent
  message (outgoing-handler ref counting, `hasLocalWorkForChat`,
  `deferDeletion` storage). The iPhone wins; a draft in a chat deleted there
  is lost.

**C5 minimal catch-up (approved, option c).** Runs on launch/resume. Applies
Apple's current state; keeps no baseline of its own.
- *Read:* server snapshot trimmed to `{guid, read}` per chat (keeps the Mark
  Unread fix). App sets each chat's unread to match through the existing
  `setChatHasUnreadFromServer`, and clears notifications for chats that are
  read. ~25 lines.
- *Message deletes:* server snapshot = message GUIDs currently in Recently
  Deleted, plus whether each chat still has live messages. App hides any it
  holds that aren't hidden yet (reusing the live-event apply path, which also
  fixes the preview). ~25 lines.
- *Whole-chat deletes:* a chat whose messages are all in Recently Deleted is
  soft-deleted with stock `softDeleteChat`. ~10 lines. A positive signal
  ("Apple has it in the trash"), so no first-run seed or baseline is needed.
- *Never does restores* — that's what removes the need for a baseline.
  Restores still work live through the push.
- Dropped: both baselines, schema migrations, stale-snapshot rejection,
  serialized apply, deferred deletions, forward-only transition machinery,
  `isArchived` / `messageCount` in the snapshot.
- Accepted gaps: a restore on Apple while the Pixel missed the push; a message
  permanently purged before the Pixel ever saw it deleted.
- Size estimate (not yet written): ~60–80 lines of app logic instead of ~950;
  server snapshot code roughly the same, slightly trimmed.

**How Recently Deleted works (from source, for reference):**
- Stock app has two message deletes, both Android-only: hard delete
  (`deleteMessage`, long-press menu, removes the row) and soft delete
  (`softDeleteMessage`, multi-select header, sets `dateDeleted`; the view
  hides those rows). Neither reaches Apple. No server event deletes messages.
- Ours reuses stock soft delete. Server polls `chat_recoverable_message_join`
  (Apple's Recently Deleted, Ventura+) and emits `message-deleted` /
  `message-restored`. App sets/clears `dateDeleted` through the stock path and
  fixes the chat preview. Permanent delete or the 30-day expiry on Apple causes
  no further change on Android; the message just stays hidden.
- Whole-chat delete on Apple: server emits `chat-deleted`; app uses stock
  `softDeleteChat`, restorable under Settings → Soft-Deleted Chats.

### #3306 — app, Find My: KEEP ALL (Swapnav, 2026-10-26)
+2952/−602, 35 files. jjoelj offered to review it standalone. I recommended
cutting F4; Swapnav chose to keep it, in #3306 as is (not split).
- F1 Bug fixes: unreachable last rows; AirPods listed twice; a new location
  stream per refresh; spinner stuck forever; `Bad state` crash on the panel
  handle; avatar initials wrapping; tab controller disposed twice.
- F2 Friends sorted nearest-first; no-location friends as a plain section.
- F3 Map opens immediately from cached data, plus last-known location when
  Apple has no fix (`findmy_location_cache`).
- F4 iPhone-style redesign: three panel stops, selected card, marker grouping,
  synced map/list selection, My/Other Devices grouping, per-friend spinners.
- F5 While Redacted Mode is on, friends' locations are not written to the phone
  and any saved ones are deleted. Exists because F3 stores locations; stock
  never stored them. (Redacted Mode = stock setting under Settings → Advanced,
  hides names/content/avatars for screenshots.)

### #855 — server, Find My refresh: S4 SWAP (Swapnav, 2026-10-26)
+1872/−64, 22 files.
- S1 Read friend locations from searchpartyd's SecureLocationCache (the fix:
  stock serves stale locations on Monterey/Ventura). Keep.
- S2 Match Apple's friend IDs to handles via Apple's roster. Keep (S1 needs it).
- S3 Background refresh kick, quit Find My afterwards, startup refresh. Keep.
- S4 Readable address. **Replace** the compiled `findmy-geocoder` binary,
  its Obj-C source and build script with a ~20-line JavaScript-for-Automation
  script run by macOS's built-in `osascript`, calling the same Apple
  `CLGeocoder`. Verified on bbserver 2026-10-26: "Seattle, WA" in 0.75 s, no
  permission prompt. Stock already runs AppleScript and ships a script in
  `appResources/macos/tools/`. Result: no executable in the PR.
  Why not Apple's labels: the cache's `locationLabel` is literally `"$null"`
  for ordinary locations (all 28 records on Oct 4); only custom names like
  Home/Work are set, and those are kept.
- S5 `favorite_order` for clients. Kept: F2's favorites-first sort uses it.

---

## Execution log

- 2026-10-26 #3378 DONE: trimmed to `70c3706de` (+190/−5, 11 files, 1 commit;
  was +561/−47, 22 files). Spam list UI + backfill removed. 13/13 tests,
  analyzer clean. PR body rewritten. Pre-trim head kept as
  `archive/pr3378-before-trim` (`a07f1bb1f`). Note: upstream app has no tests
  of its own, so the suite = this PR's tests.
- 2026-10-26 #855 DONE: S4 swapped, new commit `2664a6cb` on top of
  `4993fde1` (no force needed). Binary + Obj-C + build script removed;
  `appResources/macos/tools/findmy-geocoder.js` added, run via
  `/usr/bin/osascript -l JavaScript`. Output verified identical to the
  binary on bbserver for 3 coordinates + 2 malformed lines. 40/40 tests;
  `tsc` shows only stock's TS2769 (fixed by #871). PR body rewritten.
- 2026-10-26 #872 DONE: rebuilt from `development` as one commit `5fe322b2`
  (+124/−1, 3 files; was +741/−5, 8 files, 7 commits). Single-step fit:
  drop participants + optional rich fields, keep text and chat fields, skip if
  still over. Title changed to "notifications for large messages are silently
  dropped". 5/5 tests; 3 fail on stock behaviour. 40-person group message:
  5,096 → 187 bytes. Read-priority commit `24ddc3f6` NOT yet moved to #856.
  Old head kept as `archive/pr872-before-trim` (`11425a90`).
- 2026-10-26 #856 DONE: head `b4dff357` (+1368/−49, 19 files; was
  +1659/−48). Added `5a944fee` = read-priority commit cherry-picked from old
  #872 `24ddc3f6`. `b4dff357` trims snapshots: chat-state → `{chats:[{guid,
  read}]}`; recoverable → `{chats:[{guid, hasMessages,
  deletedMessageGuids}]}`; no schemaVersion/complete/generatedAt. Dead
  read-state helpers removed. 52/52 tests. Body rewritten. **Snapshot format
  changed: daily.52's catch-up can't read it; daily.53 must ship with
  v8.12.19.** No force-push needed (appended).
- 2026-10-26 #3309 DONE (code; not yet on device): head `533036b59`
  (+865/−19, 24 files; was +2081/−37, 34 files). lib +534/−19 (was ~1,400).
  New `lib/services/backend/sync/apple_state_catch_up.dart` (177 lines):
  catch-up proper = 52 parse + 48 run/apply ≈ 100 lines (vs ~950); the other
  ~70 are the live-event parse and shared hide/restore path moved from the
  deleted reconciler. Removed: chat_state_reconciler, recoverable_message_
  reconciler, chat_state_transition (+ 6 test files), hasLocalWorkForChat,
  deferDeletion, setChatArchivedFromServer, baseline prefs keys,
  repairHiddenLatestMessages; outgoing_message_handler back to upstream.
  33/33 tests, analyzer 0/0. Body rewritten; dropped claims about removed
  code (repair pass, baselines). Appended, no force-push.

## Execution checklist (needs Swapnav's go)

- [ ] Apply PR edits; rewrite each changed PR's description to match
      (#3378, #872, #856, #3309, #855)
- [ ] Server tests + app tests + analyzer
- [ ] Build daily.53 and v8.12.19 as upstream + PRs + one private commit
- [ ] Deploy server with the rollback watchdog; confirm stand-down
- [ ] Install daily.53 on the Pixel
- [ ] Run `docs/reconcile.sh`; update `docs/RECONCILIATION.md`
- [ ] Copy this file to `docs/PR-REVIEW.md` on both `deployed/*` branches
- [ ] Mark each executed decision "Done" here, with the commit

---

## Change log
- 2026-10-26: file created. #874 keep, #3378 trim, #872 re-scope approved.
- 2026-10-26: #3309/#856 cuts C1–C4 and minimal catch-up C5(c) approved.
- 2026-10-26: Find My decided: #3306 keep all (F1–F5); #855 S4 swapped to a
  built-in JavaScript script. All reviews decided.
