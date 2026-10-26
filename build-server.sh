#!/bin/bash
# Rebuild the custom BlueBubbles server main.js from this tree.
# Toolchain: Nix nodejs_22 (22.23.3 / npm 10.9.9) — NOT nvm.
# node_modules is disposable: delete it after a deploy; this recreates it in seconds.
set -euo pipefail
export PATH=/nix/var/nix/profiles/default/bin:$PATH
cd "$(dirname "$0")"
LOGDIR="$HOME/BlueBubbles-v812-Package"
nix shell nixpkgs#nodejs_22 -c bash -c "
  set -e
  [ -d node_modules ] || npm ci --ignore-scripts --no-audit --no-fund > '$LOGDIR/npm-ci.log' 2>&1
  npm run build --workspace packages/server > '$LOGDIR/build.log' 2>&1
"
M=packages/server/dist/main.js
shasum -a 256 "$M" "$M.map"
for marker in swapnav/readsync-findmy-v812 CUSTOM_BUILD_UPDATE_DISABLED BeaconStoreKey chat-deleted chat-state/snapshot 'filename*=UTF-8'; do
  grep -qF "$marker" "$M" || { echo "MISSING MARKER: $marker" >&2; exit 1; }
done
echo "build ok; all markers present"
