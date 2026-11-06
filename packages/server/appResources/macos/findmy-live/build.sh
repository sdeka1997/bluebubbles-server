#!/bin/bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")" && pwd)
BUILD="$ROOT/.build"
rm -rf "$BUILD"
mkdir -p "$BUILD/modules/FMFCore.swiftmodule"
cp "$ROOT/source/FMFCore.swiftinterface" "$BUILD/modules/FMFCore.swiftmodule/x86_64-apple-macos.swiftinterface"

xcrun swiftc -target x86_64-apple-macosx15.0 -emit-library -I "$BUILD/modules" "$ROOT/source/live.swift" \
  -Xlinker -undefined -Xlinker dynamic_lookup \
  -Xlinker -install_name -Xlinker @rpath/libBlueBubblesFindMyLive.dylib \
  -o "$BUILD/libBlueBubblesFindMyLive.dylib"
xcrun clang -target x86_64-apple-macosx15.0 -dynamiclib -fobjc-arc -framework Foundation \
  "$ROOT/source/shim.m" -L "$BUILD" -lBlueBubblesFindMyLive \
  -Wl,-rpath,@loader_path -Wl,-install_name,@rpath/BlueBubblesFindMyBridge.dylib \
  -o "$BUILD/BlueBubblesFindMyBridge.dylib"
install_name_tool -change libBlueBubblesFindMyLive.dylib @loader_path/libBlueBubblesFindMyLive.dylib \
  "$BUILD/BlueBubblesFindMyBridge.dylib" 2>/dev/null || true
codesign -s - -f "$BUILD/libBlueBubblesFindMyLive.dylib" "$BUILD/BlueBubblesFindMyBridge.dylib" >/dev/null
codesign --verify --strict "$BUILD/libBlueBubblesFindMyLive.dylib" "$BUILD/BlueBubblesFindMyBridge.dylib"
file "$BUILD"/*.dylib | grep -q x86_64
BRIDGE_ID=$(otool -D "$BUILD/BlueBubblesFindMyBridge.dylib" | sed -n '2p')
if [ "$BRIDGE_ID" != "@rpath/BlueBubblesFindMyBridge.dylib" ]; then
  echo "unexpected bridge install name: $BRIDGE_ID" >&2
  exit 1
fi
if nm -gU "$BUILD/BlueBubblesFindMyBridge.dylib" | grep -q bbfm_set_test_manager; then
  echo "test-only manager setter leaked into production bridge" >&2
  exit 1
fi
mv "$BUILD/libBlueBubblesFindMyLive.dylib" "$ROOT/libBlueBubblesFindMyLive.dylib"
mv "$BUILD/BlueBubblesFindMyBridge.dylib" "$ROOT/BlueBubblesFindMyBridge.dylib"
rm -rf "$BUILD"
echo "Find My live bridge: built x86_64 and verified"
