#!/usr/bin/env bash
# Builds XPGlassPad into dist/XPGlassPad/  (needs: mingw-w64 for Windows, g++ for Linux, clang on macOS)
#   ./build.sh win | lin | mac | all
set -euo pipefail
cd "$(dirname "$0")"
OUT=dist/XPGlassPad
mkdir -p "$OUT/64" build
SRC="src/main.cpp"
FLAGS="-O2 -std=c++17 -Isrc -Ithird_party -fvisibility=hidden"

win() {
  x86_64-w64-mingw32-dlltool -d src/xplm_64.def -l build/libXPLM_64.a
  x86_64-w64-mingw32-g++ $FLAGS -shared -o "$OUT/64/win.xpl" $SRC -Lbuild -lXPLM_64 -lws2_32 -static -s
}
lin() {
  g++ $FLAGS -fPIC -shared -o "$OUT/64/lin.xpl" $SRC -lpthread -ldl -static-libstdc++ -static-libgcc -s
}
mac() {
  clang++ $FLAGS -arch x86_64 -arch arm64 -mmacosx-version-min=11.0 -dynamiclib \
    -undefined dynamic_lookup -o "$OUT/64/mac.xpl" $SRC
}
case "${1:-all}" in
  win) win ;; lin) lin ;; mac) mac ;;
  all) win; lin ;;
esac
rm -rf "$OUT/web"; cp -r web "$OUT/web"
cp dist-files/config.ini dist-files/README.txt LICENSE "$OUT/"
cp THIRD_PARTY_NOTICES.md "$OUT/"
echo "built -> $OUT"
