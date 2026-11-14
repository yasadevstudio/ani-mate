#!/bin/bash
# YASA PRESENTS
# build-phone-signed.sh: a signed APK of what is in this folder, for YOUR OWN phone.
#
#     bash scripts/build-phone-signed.sh               build it, say where it is
#     bash scripts/build-phone-signed.sh --install     and put it on the phone on USB
#     bash scripts/build-phone-signed.sh --inspect     a build whose page can be examined
#                                                      from this computer (see below)
#
# ⛔ THIS IS NOT A RELEASE. Nothing is committed, tagged, uploaded or published. It makes
# one file on this machine. A release is cut from a tag, by CI, on his word and under the
# number he names (see CLAUDE.md).
#
# WHY IT EXISTS. The phone only takes an update that is signed with the same key as the
# app already on it. CI has that key as a secret; a debug build is signed with another
# one, and installing it would mean removing the app and its data first. So to try the
# working tree on a phone that has ANI-MATE on it, the build has to be signed with the
# release key, here, by the person who knows its password.
#
# THE PASSWORD is asked for on the terminal, is not shown, is not written anywhere, and
# never appears on a command line (Gradle and keytool are handed it through the
# environment of their own process). Nothing else on the machine learns it.
#
# --install uses `adb install -r`, which UPDATES the app and keeps its data. It never
# uninstalls. If the phone refuses (a different key, or a newer build already on it) the
# script says so and stops there.
#
# --inspect makes the same app with one switch on: its page can be opened from this
# computer over USB (WebView debugging). scripts/phone-referer-check.js uses that to
# measure, on the real phone, which Referer leaves the app. Do not keep an --inspect
# build as your everyday copy: build again without the flag, or install the release.
#
# Needs: the JDK and Android SDK (defaults: ~/android-toolchain), Node, and the keystore
# (default: ~/ANIMATE/ani-mate-release.keystore, alias ani-mate; ANIMATE_KEYSTORE and
# ANIMATE_KEY_ALIAS override).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KEYSTORE="${ANIMATE_KEYSTORE:-$HOME/ANIMATE/ani-mate-release.keystore}"
ALIAS="${ANIMATE_KEY_ALIAS:-ani-mate}"
export JAVA_HOME="${JAVA_HOME:-$HOME/android-toolchain/jdk-21.0.12.1+1}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/android-toolchain/sdk}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
ADB="$ANDROID_HOME/platform-tools/adb"
ASSET_CFG="$ROOT/mobile/android/app/src/main/assets/capacitor.config.json"

INSPECT=0
INSTALL=0
for arg in "$@"; do
    case "$arg" in
        --inspect) INSPECT=1 ;;
        --install) INSTALL=1 ;;
        -h|--help) sed -n '3,35p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown option: $arg (see --help)"; exit 2 ;;
    esac
done

[ -x "$JAVA_HOME/bin/keytool" ] || { echo "no JDK at $JAVA_HOME (set JAVA_HOME)"; exit 2; }
[ -d "$ANDROID_HOME/platforms" ] || { echo "no Android SDK at $ANDROID_HOME (set ANDROID_HOME)"; exit 2; }
[ -f "$KEYSTORE" ] || { echo "no keystore at $KEYSTORE (set ANIMATE_KEYSTORE)"; exit 2; }

# ── the password: from the terminal, checked before a build is spent on it ───────────
if [ -z "${ANIMATE_KEYSTORE_PASSWORD:-}" ]; then
    read -r -s -p "Keystore password (not shown): " ANIMATE_KEYSTORE_PASSWORD
    echo
fi
export ANIMATE_KEYSTORE_PASSWORD
if ! "$JAVA_HOME/bin/keytool" -list -keystore "$KEYSTORE" -alias "$ALIAS" \
        -storepass:env ANIMATE_KEYSTORE_PASSWORD >/dev/null 2>&1; then
    echo "That password does not open $KEYSTORE, or it holds no key named '$ALIAS'. Nothing was built."
    exit 1
fi
OURS="$("$JAVA_HOME/bin/keytool" -list -v -keystore "$KEYSTORE" -alias "$ALIAS" \
        -storepass:env ANIMATE_KEYSTORE_PASSWORD 2>/dev/null \
        | sed -n 's/^[[:space:]]*SHA256:[[:space:]]*//p' | head -1 | tr -d ':' | tr 'A-F' 'a-f')"

# ── the page into the APK folder, exactly as a release build gets it ─────────────────
cd "$ROOT"
npm run -s sync:shared
[ -f "$ASSET_CFG" ] || (cd mobile && npx cap sync android >/dev/null)

# --inspect: one switch in the copy of the config the APK carries. That file is build
# output (git ignores it); it is put back the way it was when this script ends.
RESTORE=""
if [ "$INSPECT" = "1" ]; then
    RESTORE="$(mktemp)"
    cp "$ASSET_CFG" "$RESTORE"
    trap 'cp "$RESTORE" "$ASSET_CFG"; rm -f "$RESTORE"' EXIT
    node -e '
        const fs = require("fs");
        const p = process.argv[1];
        const c = JSON.parse(fs.readFileSync(p, "utf8"));
        c.android = Object.assign({}, c.android, { webContentsDebuggingEnabled: true });
        fs.writeFileSync(p, JSON.stringify(c, null, "\t"));' "$ASSET_CFG"
    echo "  this build can be examined over USB (--inspect)"
fi

# ── the build ────────────────────────────────────────────────────────────────────────
echo "  building (about a minute)..."
cd "$ROOT/mobile/android"
ORG_GRADLE_PROJECT_RELEASE_STORE_FILE="$KEYSTORE" \
ORG_GRADLE_PROJECT_RELEASE_KEY_ALIAS="$ALIAS" \
ORG_GRADLE_PROJECT_RELEASE_STORE_PASSWORD="$ANIMATE_KEYSTORE_PASSWORD" \
ORG_GRADLE_PROJECT_RELEASE_KEY_PASSWORD="$ANIMATE_KEYSTORE_PASSWORD" \
    ./gradlew :app:assembleRelease --no-daemon -q

APK="$(ls -t "$ROOT"/mobile/android/app/build/outputs/apk/release/*-mobile.apk 2>/dev/null | head -1 || true)"
[ -n "$APK" ] || { echo "the build finished and left no APK"; exit 1; }

# ── is it really signed with the release key ─────────────────────────────────────────
APKSIGNER="$(ls "$ANDROID_HOME"/build-tools/*/apksigner 2>/dev/null | sort -V | tail -1)"
# (apksigner is a script that runs whatever `java` is on PATH; this machine has none
# there, so it is given the JDK's.)
SIGNED_BY="$(PATH="$JAVA_HOME/bin:$PATH" "$APKSIGNER" verify --print-certs "$APK" 2>/dev/null \
        | sed -n 's/^Signer #1 certificate SHA-256 digest: //p' | head -1 || true)"
if [ -z "$SIGNED_BY" ] || [ "$SIGNED_BY" != "$OURS" ]; then
    echo "The APK is NOT signed with the key in $KEYSTORE (signed by ${SIGNED_BY:-nothing readable})."
    echo "Do not install it."
    exit 1
fi

# Kept outside Gradle's own output folder, which the next build empties. (*.apk is
# ignored by git.)
mkdir -p "$ROOT/mobile/local-builds"
OUT="$ROOT/mobile/local-builds/$(basename "$APK" .apk)-LOCAL$([ "$INSPECT" = "1" ] && echo '-inspect' || true).apk"
cp "$APK" "$OUT"
echo
echo "  built   $OUT"
echo "  size    $(du -h "$OUT" | cut -f1), signed with the release key (${OURS:0:16}...)"
echo "  version $(node -p "require('$ROOT/package.json').version"), not a release"

# ── onto the phone ───────────────────────────────────────────────────────────────────
if [ "$INSTALL" = "1" ]; then
    COUNT="$("$ADB" devices | sed '1d' | grep -c 'device$' || true)"
    if [ "$COUNT" != "1" ]; then
        echo
        echo "  --install needs exactly one phone on USB with USB debugging on; adb sees $COUNT."
        echo "  The APK is built. Plug the phone in and run:  $ADB install -r \"$OUT\""
        exit 1
    fi
    echo "  installing over the app on the phone (an update: its data stays)..."
    if "$ADB" install -r "$OUT"; then
        echo "  installed."
    else
        echo
        echo "  The phone refused it. Nothing was removed. The usual reasons: the app on the"
        echo "  phone was signed with a different key, or it is a newer build than this one."
        exit 1
    fi
else
    echo
    echo "  To put it on the phone: plug it in with USB debugging on and run"
    echo "      $ADB install -r \"$OUT\""
    echo "  or copy the file to the phone and open it there."
fi
if [ "$INSPECT" = "1" ]; then
    echo
    echo "  With the app open on the phone:   node scripts/phone-referer-check.js"
fi
