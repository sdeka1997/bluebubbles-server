#!/bin/bash
# Verifies and installs a BubbleBeam Server update without touching its Application Support data.
# Usage: install-bubblebeam-update.sh [--verify-only] ARCHIVE SHA256 CURRENT_APP [READY_MARKER CURRENT_PID TAG]
set -Eeuo pipefail
umask 077

MODE=install
if [ "${1:-}" = "--verify-only" ]; then MODE=verify; shift; fi
[ $# -ge 3 ] || { echo "usage: $0 [--verify-only] ARCHIVE SHA256 CURRENT_APP [READY_MARKER CURRENT_PID TAG]" >&2; exit 2; }
ARCHIVE=$1
EXPECTED_SHA=$(printf '%s' "$2" | tr 'A-F' 'a-f')
CURRENT=$3
READY_MARKER=${4:-}
CURRENT_PID=${5:-0}
TAG=${6:-verification}

LOG_DIR="$HOME/Library/Application Support/bluebubbles-server"
LOG="$LOG_DIR/update-install.log"
LOCK="$HOME/Library/Caches/com.bluebubbles.server-update.lock"
STAGE="$(dirname "$CURRENT")/.bubblebeam-update.$$"
OLD="$CURRENT.pre-update"
mkdir -p "$LOG_DIR" "$HOME/Library/Caches"
LOCK_OWNED=false

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$LOG"; }
fail() { log "FAILED: $*" >&2; exit 1; }
archive_path_escapes() {
    local value="$1" depth=0 part
    [[ "$value" != /* ]] || return 0
    local IFS='/'
    read -ra parts <<< "$value"
    for part in "${parts[@]}"; do
        case "$part" in
            ''|.) ;;
            ..) [ "$depth" -gt 0 ] || return 0; depth=$((depth - 1)) ;;
            *) depth=$((depth + 1)) ;;
        esac
    done
    return 1
}
preflight_archive() {
    local entries duplicates first_duplicate entry target base
    entries=$(/usr/bin/zipinfo -1 "$ARCHIVE") || return 1
    [ -n "$entries" ] || return 1
    duplicates=$(printf '%s\n' "$entries" | LC_ALL=C /usr/bin/sort | /usr/bin/uniq -d)
    first_duplicate=${duplicates%%$'\n'*}
    [ -z "$duplicates" ] || fail "duplicate archive entry: $first_duplicate"
    while IFS= read -r entry; do
        [ -n "$entry" ] || return 1
        archive_path_escapes "$entry" && fail "unsafe archive path: $entry"
        if /usr/bin/zipinfo -l "$ARCHIVE" "$entry" | /usr/bin/awk '$1 ~ /^l/ { found=1 } END { exit !found }'; then
            target=$(/usr/bin/unzip -p "$ARCHIVE" "$entry") || return 1
            [ -n "$target" ] || fail "unsafe empty archive symlink target: $entry"
            base=${entry%/*}; [ "$base" != "$entry" ] || base=
            archive_path_escapes "${base:+$base/}$target" && fail "unsafe archive symlink target: $entry -> $target"
        fi
    done <<< "$entries"
}
escape_process_pattern() {
    printf '%s' "$1" | /usr/bin/sed 's/[][(){}.^$*+?|\\]/\\&/g'
}
server_process_pattern() {
    local escaped
    escaped=$(escape_process_pattern "$CURRENT/Contents/MacOS/BlueBubbles")
    printf '^%s( .*)?$' "$escaped"
}
server_is_running() {
    /usr/bin/pgrep -f "$(server_process_pattern)" >/dev/null
}
stop_new_server() {
    local pattern
    pattern=$(server_process_pattern)
    /usr/bin/pkill -TERM -f "$pattern" 2>/dev/null || true
    for _ in $(seq 1 10); do
        server_is_running || return 0
        /bin/sleep 1
    done
    /usr/bin/pkill -KILL -f "$pattern" 2>/dev/null || true
    for _ in $(seq 1 5); do
        server_is_running || return 0
        /bin/sleep 1
    done
    ! server_is_running
}
restore_configuration() {
    [ -f "$CONFIG_BACKUP" ] || return 0
    local restored="$CONFIG.restore.$$"
    rm -f "$restored"
    /bin/cp "$CONFIG_BACKUP" "$restored" || return 1
    [ "$(/usr/bin/sqlite3 "$restored" 'PRAGMA integrity_check;')" = ok ] || { rm -f "$restored"; return 1; }
    rm -f "$CONFIG-wal" "$CONFIG-shm"
    /bin/mv "$restored" "$CONFIG" || return 1
    [ "$(/usr/bin/sqlite3 "$CONFIG" 'PRAGMA integrity_check;')" = ok ]
}
cleanup() { rm -rf "$STAGE"; [ "$LOCK_OWNED" = false ] || rmdir "$LOCK" 2>/dev/null || true; }
trap cleanup EXIT

mkdir "$LOCK" 2>/dev/null || fail "another update is already running"
LOCK_OWNED=true
[ -f "$ARCHIVE" ] || fail "update archive is missing"
[ -e "$CURRENT" ] || fail "current app is missing"
[[ "$EXPECTED_SHA" =~ ^[a-f0-9]{64}$ ]] || fail "checksum is malformed"
ACTUAL_SHA=$(/usr/bin/shasum -a 256 "$ARCHIVE" | /usr/bin/awk '{print $1}')
[ "$ACTUAL_SHA" = "$EXPECTED_SHA" ] || fail "checksum mismatch"
preflight_archive || fail "archive preflight failed"

mkdir "$STAGE"
/usr/bin/ditto -x -k "$ARCHIVE" "$STAGE" || fail "archive could not be extracted"
NEW="$STAGE/BlueBubbles.app"
[ -d "$NEW" ] || fail "archive does not contain BlueBubbles.app"
[ "$(find "$STAGE" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')" = 1 ] || fail "archive contains unexpected top-level files"
/usr/bin/codesign --verify --deep --strict "$NEW" || fail "new app's code signature is invalid"
CURRENT_REQ=$(/usr/bin/codesign -d -r- "$CURRENT" 2>&1 | /usr/bin/sed -n 's/^designated => //p')
NEW_REQ=$(/usr/bin/codesign -d -r- "$NEW" 2>&1 | /usr/bin/sed -n 's/^designated => //p')
[ -n "$CURRENT_REQ" ] && [ "$NEW_REQ" = "$CURRENT_REQ" ] || fail "designated requirement does not match the installed app"
CURRENT_ID=$(/usr/bin/defaults read "$CURRENT/Contents/Info.plist" CFBundleIdentifier)
NEW_ID=$(/usr/bin/defaults read "$NEW/Contents/Info.plist" CFBundleIdentifier)
[ "$NEW_ID" = "$CURRENT_ID" ] || fail "CFBundleIdentifier does not match the installed app"
log "verified $TAG ($ACTUAL_SHA)"
[ "$MODE" = verify ] && exit 0

[ -n "$READY_MARKER" ] || fail "ready marker path is missing"
[ "$CURRENT_PID" -gt 1 ] 2>/dev/null || fail "current server pid is invalid"
[ ! -e "$OLD" ] || fail "a previous update's temporary app still exists"
BACKUP_DIR="$HOME/BlueBubbles-Staging/update-backups"
BACKUP_APP="$BACKUP_DIR/BlueBubbles-pre-${TAG//[^A-Za-z0-9._-]/_}.app"
CONFIG="$LOG_DIR/config.db"
CONFIG_BACKUP="$BACKUP_DIR/config-pre-${TAG//[^A-Za-z0-9._-]/_}-$(date -u +%Y%m%dT%H%M%SZ).db"
[ ! -L "$BACKUP_DIR" ] || fail "backup directory must not be a symlink"
mkdir -p "$BACKUP_DIR"
/bin/chmod 700 "$BACKUP_DIR" || fail "could not secure backup directory"
[ "$(/usr/bin/stat -f %Lp "$BACKUP_DIR")" = 700 ] || fail "backup directory permissions are unsafe"
rm -rf "$BACKUP_APP"
/usr/bin/ditto "$CURRENT" "$BACKUP_APP" || fail "current app backup failed"
if [ -f "$CONFIG" ]; then
    /usr/bin/sqlite3 "file:$CONFIG?mode=ro" ".backup '$CONFIG_BACKUP'" || fail "configuration backup failed"
    /bin/chmod 600 "$CONFIG_BACKUP" || fail "could not secure configuration backup"
    [ "$(/usr/bin/stat -f %Lp "$CONFIG_BACKUP")" = 600 ] || fail "configuration backup permissions are unsafe"
    [ "$(/usr/bin/sqlite3 "$CONFIG_BACKUP" 'PRAGMA integrity_check;')" = ok ] || fail "configuration backup failed PRAGMA integrity_check"
fi

/usr/bin/touch "$READY_MARKER" || fail "could not write ready marker"
log "waiting for server pid $CURRENT_PID to exit"
for _ in $(seq 1 60); do
    /bin/kill -0 "$CURRENT_PID" 2>/dev/null || break
    /bin/sleep 1
done
/bin/kill -0 "$CURRENT_PID" 2>/dev/null && fail "server did not exit within 60 seconds"

/bin/mv "$CURRENT" "$OLD" || fail "could not move the installed app aside"
if ! /bin/mv "$NEW" "$CURRENT"; then
    /bin/mv "$OLD" "$CURRENT" || true
    fail "could not move the new app into Applications"
fi
/usr/bin/open -a "$CURRENT" || true

HEALTHY=false
for _ in $(seq 1 20); do
    if server_is_running; then HEALTHY=true; fi
    [ "$HEALTHY" = true ] && /bin/sleep 5 && server_is_running && break
    /bin/sleep 1
    HEALTHY=false
done

if [ "$HEALTHY" != true ] || ! server_is_running; then
    log "new server did not stay running; rolling back"
    stop_new_server || fail "new server would not stop during rollback"
    rm -rf "$CURRENT"
    /bin/mv "$OLD" "$CURRENT"
    restore_configuration || fail "configuration rollback failed PRAGMA integrity_check"
    /usr/bin/open -a "$CURRENT" || true
    fail "new server failed its launch health check; restored the previous app"
fi

rm -rf "$OLD"
log "installed $TAG successfully"
