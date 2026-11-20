#!/bin/sh
# Builds the TokenBeacon Display APK offline with the Android SDK command-line
# tools only (aapt2, javac, d8, apksigner): no Gradle, no downloads, no
# third-party libraries. Also runs the JVM protocol test against the shared
# vectors. Output: android/build/tokenbeacon-display.apk (debug-signed with a
# local key in android/build/, never committed).
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
APP="$ROOT/android/app"
OUT="$ROOT/android/build"
SDK=${ANDROID_HOME:-"$HOME/Library/Android/sdk"}
BUILD_TOOLS_VERSION=${BUILD_TOOLS_VERSION:-36.1.0}
PLATFORM_VERSION=${PLATFORM_VERSION:-android-35}
# Tested with build-tools 36.1.0 and android-35. Elsewhere (e.g. CI runners)
# the newest installed versions are used if these are missing.
if [ ! -d "$SDK/build-tools/$BUILD_TOOLS_VERSION" ] && [ -d "$SDK/build-tools" ]; then
  BUILD_TOOLS_VERSION=$(ls "$SDK/build-tools" | sort -V | tail -1)
fi
if [ ! -f "$SDK/platforms/$PLATFORM_VERSION/android.jar" ] && [ -d "$SDK/platforms" ]; then
  PLATFORM_VERSION=$(ls "$SDK/platforms" | grep -E '^android-[0-9]+$' | sort -V | tail -1)
fi
echo "Android SDK: build-tools $BUILD_TOOLS_VERSION, $PLATFORM_VERSION"
BT="$SDK/build-tools/$BUILD_TOOLS_VERSION"
ANDROID_JAR="$SDK/platforms/$PLATFORM_VERSION/android.jar"
if [ -z "${JAVA_HOME:-}" ] && [ -d "/Applications/Android Studio.app/Contents/jbr/Contents/Home" ]; then
  JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
fi
JAVA="${JAVA_HOME:?set JAVA_HOME to a JDK 17+}/bin"
export JAVA_HOME PATH="$JAVA:$PATH" # d8 and apksigner start java from PATH

for tool in "$BT/aapt2" "$BT/d8" "$BT/zipalign" "$BT/apksigner" "$ANDROID_JAR" "$JAVA/javac"; do
  [ -e "$tool" ] || { echo "missing: $tool" >&2; exit 1; }
done

rm -rf "$OUT/classes" "$OUT/test-classes" "$OUT/dex" "$OUT"/*.apk
mkdir -p "$OUT/classes" "$OUT/test-classes" "$OUT/dex"

SOURCES=$(find "$APP/src" -name '*.java')

echo "== JVM protocol test (shared vectors)"
PURE="$APP/src/dev/tokenbeacon/display/Json.java $APP/src/dev/tokenbeacon/display/Protocol.java $APP/src/dev/tokenbeacon/display/LineAssembler.java $APP/src/dev/tokenbeacon/display/DisplayFormat.java $APP/src/dev/tokenbeacon/display/DisplayStore.java $APP/src/dev/tokenbeacon/display/PowerPolicy.java"
# DisplayService.FIRMWARE is the only Android class the test needs; a stub keeps the test free of android.jar.
mkdir -p "$OUT/test-src/dev/tokenbeacon/display"
cat > "$OUT/test-src/dev/tokenbeacon/display/DisplayService.java" <<'EOF'
package dev.tokenbeacon.display;
final class DisplayService { static final String FIRMWARE = "android-0.1.0"; }
EOF
grep -q 'FIRMWARE = "android-0.1.0"' "$APP/src/dev/tokenbeacon/display/DisplayService.java" || { echo "test stub FIRMWARE is out of date" >&2; exit 1; }
# shellcheck disable=SC2086
"$JAVA/javac" -Xlint:-options --release 17 -d "$OUT/test-classes" $PURE "$OUT/test-src/dev/tokenbeacon/display/DisplayService.java" \
  "$ROOT/android/test/dev/tokenbeacon/display/ProtocolTest.java"
"$JAVA/java" -cp "$OUT/test-classes" dev.tokenbeacon.display.ProtocolTest "$ROOT/tests/device-vectors/host-to-device.jsonl"

echo "== compile"
# shellcheck disable=SC2086
# JDK class library for java.*, android.jar for android.*; d8 desugars to the min API.
"$JAVA/javac" -Xlint:-options --release 11 -classpath "$ANDROID_JAR" -d "$OUT/classes" $SOURCES
"$BT/d8" --min-api 26 --lib "$ANDROID_JAR" --output "$OUT/dex" $(find "$OUT/classes" -name '*.class')

echo "== package"
"$BT/aapt2" link --manifest "$APP/AndroidManifest.xml" -I "$ANDROID_JAR" \
  --min-sdk-version 26 --target-sdk-version 34 -o "$OUT/unsigned.apk"
(cd "$OUT/dex" && zip -q -j "$OUT/unsigned.apk" classes.dex)
"$BT/zipalign" -f -p 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"

KEYSTORE="$OUT/debug.keystore"
if [ ! -f "$KEYSTORE" ]; then
  "$JAVA/keytool" -genkeypair -keystore "$KEYSTORE" -storepass android -keypass android \
    -alias debug -keyalg RSA -keysize 2048 -validity 3650 -dname "CN=TokenBeacon Display Debug" >/dev/null 2>&1
fi
"$BT/apksigner" sign --ks "$KEYSTORE" --ks-pass pass:android --key-pass pass:android \
  --out "$OUT/tokenbeacon-display.apk" "$OUT/aligned.apk"
"$BT/apksigner" verify "$OUT/tokenbeacon-display.apk"
rm -f "$OUT/unsigned.apk" "$OUT/aligned.apk"
ls -l "$OUT/tokenbeacon-display.apk"
