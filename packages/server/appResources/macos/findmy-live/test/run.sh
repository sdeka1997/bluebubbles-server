#!/bin/bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
BUILD="$ROOT/build"
SOURCE="$ROOT/source"
rm -rf "$BUILD"
mkdir -p "$BUILD/modules/FMFCore.swiftmodule"
trap 'rm -rf "$BUILD"' EXIT

# Test implementation of FMFCore.
xcrun swiftc -target x86_64-apple-macosx15.0 -enable-library-evolution \
  -emit-library -emit-module -module-name FMFCore \
  "$ROOT/test/FMFCore.swift" -Xlinker -install_name -Xlinker @rpath/libFMFCore.dylib \
  -o "$BUILD/libFMFCore.dylib"

# Real bridge, linked against only the declarations exported by Apple's FMFCore.
cp "$SOURCE/FMFCore.swiftinterface" "$BUILD/modules/FMFCore.swiftmodule/x86_64-apple-macos.swiftinterface"
xcrun swiftc -target x86_64-apple-macosx15.0 -emit-library -I "$BUILD/modules" "$SOURCE/live.swift" \
  -Xlinker -undefined -Xlinker dynamic_lookup \
  -Xlinker -install_name -Xlinker @rpath/libBlueBubblesFindMyLive.dylib \
  -o "$BUILD/libBlueBubblesFindMyLive.dylib"
xcrun clang -target x86_64-apple-macosx15.0 -DBBFM_TEST -dynamiclib -fobjc-arc -framework Foundation \
  "$SOURCE/shim.m" -L "$BUILD" -lBlueBubblesFindMyLive -Wl,-rpath,@loader_path \
  -o "$BUILD/BlueBubblesFindMyBridge.dylib"
install_name_tool -change libBlueBubblesFindMyLive.dylib @loader_path/libBlueBubblesFindMyLive.dylib \
  "$BUILD/BlueBubblesFindMyBridge.dylib" 2>/dev/null || true
codesign -s - -f "$BUILD/libBlueBubblesFindMyLive.dylib" "$BUILD/BlueBubblesFindMyBridge.dylib" >/dev/null

# Test host links the test-only setter and keeps one fake manager alive.
xcrun swiftc -target x86_64-apple-macosx15.0 -I "$BUILD" -L "$BUILD" \
  -lFMFCore "$BUILD/BlueBubblesFindMyBridge.dylib" -Xlinker -rpath -Xlinker @executable_path \
  "$ROOT/test/host.swift" -o "$BUILD/host"
# Second host: no test setter; its manager appears 0.5 s in and the bridge must find it itself.
xcrun swiftc -target x86_64-apple-macosx15.0 -I "$BUILD" -L "$BUILD" \
  -lFMFCore "$BUILD/BlueBubblesFindMyBridge.dylib" -Xlinker -rpath -Xlinker @executable_path \
  "$ROOT/test/host_scan.swift" -o "$BUILD/host_scan"
python3 "$ROOT/test/test_bridge.py"
python3 "$ROOT/test/test_scan.py"