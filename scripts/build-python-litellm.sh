#!/bin/bash
# ── Build bundled Python + LiteLLM venv into resources/litellm/ ──────────────
#
# Downloads python-build-standalone (pinned release, macOS arm64), creates a
# venv, and installs litellm[proxy] at the pinned version. Runs during
# `npm run dist` (via predist). Skips if already built (cached).
#
# Fixes for the failures seen in the previous bundle-services attempt:
#  1. Correct python-build-standalone URL (the previous one 404'd -> 9-byte page).
#  2. Thread the http proxy to curl via --proxy (inherited env can drop it).
#  3. Verify the downloaded archive is >1MB before tar -xf (catches the
#     9-byte-error-page failure mode).

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET_PY="$PROJECT_ROOT/resources/python"
TARGET_LL="$PROJECT_ROOT/resources/litellm"
PB_TAG="$(node -p "require('$PROJECT_ROOT/package.json').platformBundles.pythonBuildStandaloneTag")"
PY_VER="$(node -p "require('$PROJECT_ROOT/package.json').platformBundles.pythonVersion")"
PINNED_VERSION="$(node -p "require('$PROJECT_ROOT/package.json').platformBundles.litellmVersion")"

# macOS arm64 only in this change.
ARCH="$(uname -m)"; OS="$(uname -s)"
if [ "$OS" != "Darwin" ] || [ "$ARCH" != "arm64" ]; then
  echo "⚠️  Skipping Python/LiteLLM build: mac arm64 only. Got $OS/$ARCH"
  exit 0
fi

# Skip if already built.
if [ -x "$TARGET_PY/bin/python3" ] && [ -x "$TARGET_LL/venv/bin/litellm" ]; then
  echo "✅ Python + LiteLLM already built - skipping"
  exit 0
fi

# Proxy for curl (thread explicitly).
PROXY="${http_proxy:-${HTTP_PROXY:-}}"
CURL_PROXY=()
if [ -n "$PROXY" ]; then CURL_PROXY=(--proxy "$PROXY"); fi

mkdir -p "$TARGET_PY"
echo "🔨 Building Python $PB_TAG (cpython $PY_VER) + LiteLLM $PINNED_VERSION (macOS arm64)"

# 1. Download python-build-standalone. Use the install_only variant (extracts
#    directly to bin/lib/include - no cpython-* wrapper dir). Asset name e.g.
#    cpython-3.13.1+20250115-aarch64-apple-darwin-install_only.tar.gz
URL="https://github.com/indygreg/python-build-standalone/releases/download/${PB_TAG}/cpython-${PY_VER}+${PB_TAG}-aarch64-apple-darwin-install_only.tar.gz"
echo "Downloading: $URL"
cd "$TARGET_PY"
curl -fL ${CURL_PROXY[@]+"${CURL_PROXY[@]}"} "$URL" -o python.tar.gz

# 2. Verify the download is real (>1MB) before extracting.
SIZE=$(wc -c < python.tar.gz | tr -d ' ')
if [ "$SIZE" -lt 1000000 ]; then
  echo "❌ Downloaded archive is only ${SIZE} bytes - expected >1MB. Aborting (likely a 404 error page)."
  cat python.tar.gz
  rm -f python.tar.gz
  exit 1
fi

echo "Extracting Python..."
tar -xzf python.tar.gz
# install_only extracts to a `python/` subdir; move its contents up one level.
if [ -d python/bin ]; then
  mv python/* . 2>/dev/null || true
  rmdir python 2>/dev/null || true
fi
rm -f python.tar.gz

# 3. Create venv + install LiteLLM. (Strip stdlib AFTER - ensurepip is needed
#    to bootstrap pip in the venv.)
echo "Creating venv..."
mkdir -p "$TARGET_LL"
"$TARGET_PY/bin/python3" -m venv "$TARGET_LL/venv"
echo "Installing litellm[proxy]==$PINNED_VERSION..."
"$TARGET_LL/venv/bin/pip" install --no-cache-dir "litellm[proxy]==$PINNED_VERSION"

# 4. Now strip unused stdlib + pyc caches (base python + venv).
echo "Stripping unused standard library..."
rm -rf "$TARGET_PY/lib/python"*/test "$TARGET_PY/lib/python"*/ensurepip "$TARGET_PY/lib/python"*/idlelib "$TARGET_PY/lib/python"*/turtledemo "$TARGET_PY/lib/python"*/tkinter/test
find "$TARGET_PY" -name "*.pyc" -delete 2>/dev/null || true
find "$TARGET_LL/venv" -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true

# 5. Copy the default config template (if not already in place).
if [ ! -f "$TARGET_LL/default-config.yaml" ]; then
  cp "$PROJECT_ROOT/resources/litellm/default-config.yaml" "$TARGET_LL/default-config.yaml"
fi

echo "✅ Done: Python -> $TARGET_PY, LiteLLM -> $TARGET_LL"
