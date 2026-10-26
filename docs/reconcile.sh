#!/bin/bash
# Reconcile what is deployed against upstream + every open PR, by merged source
# tree. Reads PR heads from GitHub, never from remote-tracking refs.
# Known deliberate differences are listed in RECONCILIATION.md next to this file.
set -uo pipefail
export PATH=/opt/homebrew/bin:$PATH
APP=~/BlueBubbles-Alpha-Build/experiments/daily30-upstream
SRV=~/BlueBubbles-Server-Build-v812

check() {  # repo label remote upstream deployed_ref deployed_branch fork_slug pr_slug "n:branch ..."
  local repo=$1 label=$2 remote=$3 up=$4 dep=$5 depbr=$6 fork=$7 prslug=$8; shift 8
  echo; echo "################ $label"
  git -C "$repo" fetch -q "$remote" 2>/dev/null
  local local_dep=$(git -C "$repo" rev-parse "$dep" | cut -c1-9)
  local fork_dep=$(gh api "repos/$fork/branches/$depbr" -q '.commit.sha[0:9]' 2>/dev/null)
  echo "deployed: local $dep=$local_dep  fork $depbr=$fork_dep  $([ "$local_dep" = "$fork_dep" ] && echo OK || echo '<-- NOT PUSHED')"
  local branches=()
  for pr in "$@"; do
    local n=${pr%%:*} b=${pr#*:}
    local gh_head=$(gh pr view "$n" --repo "$prslug" --json headRefOid,mergeable -q '.headRefOid[0:9]+" "+.mergeable')
    local tip=$(gh api "repos/$fork/branches/$b" -q '.commit.sha[0:9]')
    echo "  #$n $b: PR head $gh_head | fork tip $tip $([ "${gh_head%% *}" = "$tip" ] && echo OK || echo '<-- DRIFT')"
    branches+=("$b")
  done
  git -C "$repo" branch -f _reconcile "$up" >/dev/null
  local cur=$(git -C "$repo" branch --show-current)
  git -C "$repo" switch -q _reconcile
  for b in "${branches[@]}"; do
    git -C "$repo" merge -q --no-edit "$remote/$b" >/dev/null 2>&1 || { echo "  MERGE CONFLICT merging $b onto $up"; git -C "$repo" merge --abort; }
  done
  echo "  --- source diff: deployed vs ($up + all PRs). Every file below must be explained by RECONCILIATION.md 'Known private-only differences'."
  git -C "$repo" diff -w --stat "$dep" _reconcile -- "${SRCPATHS[@]}" | cat
  git -C "$repo" switch -q "$cur"; git -C "$repo" branch -D _reconcile >/dev/null 2>&1
  echo "  uncommitted in checkout: $(git -C "$repo" status --porcelain | wc -l | tr -d ' ')"
}

SRCPATHS=(lib test)
check "$APP" APP origin upstream/master daily/39 deployed/app-daily.39-47 sdeka1997/bluebubbles-app BlueBubblesApp/bluebubbles-app \
  3309:feat/apple-read-and-delete-sync 3378:pub/chat-spam-list 3306:fix/findmy-list-order-and-inset 3370:fix/conversation-tile-select-reuse

SRCPATHS=(packages/server/src packages/server/scripts packages/server/test)
check "$SRV" SERVER forkpush forkpush/development custom-v8.12.17 deployed/server-v8.12.17 sdeka1997/bluebubbles-server BlueBubblesApp/bluebubbles-server \
  856:feat/apple-read-and-delete-sync 874:pub/chat-spam-flag 872:fix/fcm-4kb-and-read-priority 871:fix/scheduledservice-timeout-type \
  855:feat/findmy-securelocationcache-refresh 854:fix/unicode-attachment-filenames 875:fix/migration-name-minified