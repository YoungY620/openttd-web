#!/usr/bin/env bash
# Local WASM build of OpenTTD using the pinned emsdk Docker image.
# Mirrors .github/workflows/deploy.yml. Run from the repo root:
#   scripts/build-local.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/OpenTTD"
IMAGE=emscripten/emsdk:6.0.1
JOBS="$(sysctl -n hw.ncpu 2>/dev/null || nproc)"

echo "==> Preparing liblzma port and vendored base assets"
mkdir -p "$SRC/vendor/baseset"
if [ ! -f "$SRC/vendor/baseset/opengfx.obg" ]; then
  curl -L -o /tmp/opengfx.zip https://cdn.openttd.org/opengfx-releases/7.1/opengfx-7.1-all.zip
  python3 -c "import zipfile; zipfile.ZipFile('/tmp/opengfx.zip').extractall('/tmp/opengfx')"
  tar -C /tmp -xf /tmp/opengfx/opengfx-7.1.tar
  cp /tmp/opengfx-7.1/* "$SRC/vendor/baseset/"
fi
if [ ! -f "$SRC/vendor/baseset/opensfx.obs" ]; then
  curl -L -o /tmp/opensfx.zip https://cdn.openttd.org/opensfx-releases/1.0.3/opensfx-1.0.3-all.zip
  python3 -c "import zipfile; zipfile.ZipFile('/tmp/opensfx.zip').extractall('/tmp/opensfx')"
  tar -C /tmp -xf /tmp/opensfx/opensfx-1.0.3.tar
  cp /tmp/opensfx-1.0.3/* "$SRC/vendor/baseset/"
fi

DOCKER_RUN=(docker run --rm -v "$ROOT:$ROOT" -w "$ROOT" "$IMAGE")

echo "==> Installing liblzma emscripten port into the image container"
# The port file is copied at container start via --entrypoint trickery:
# simpler to bake a derived image once.
docker build -t emsdk-openttd-local -f "$SRC/os/emscripten/Dockerfile" "$SRC/os/emscripten"
DOCKER_RUN=(docker run --rm -v "$ROOT:$ROOT" -w "$ROOT" emsdk-openttd-local)

echo "==> Building host tools (native)"
"${DOCKER_RUN[@]}" -w "$ROOT/build-host" bash -c \
  "cmake ../OpenTTD -DOPTION_TOOLS_ONLY=ON && cmake --build . -j $JOBS --target tools"

echo "==> Building WASM game"
"${DOCKER_RUN[@]}" -w "$ROOT/build" bash -c \
  "emcmake cmake ../OpenTTD -DHOST_BINARY_DIR=$ROOT/build-host -DCMAKE_BUILD_TYPE=Release -DOPTION_USE_ASSERTS=OFF && cmake --build . -j $JOBS --target openttd"

echo "==> Assembling site/ (GitHub Pages content)"
rm -rf "$ROOT/site"
mkdir -p "$ROOT/site"
cp "$ROOT/build/openttd.html" "$ROOT/site/index.html"
cp "$ROOT/build/openttd.js" "$ROOT/build/openttd.wasm" "$ROOT/build/openttd.data" "$ROOT/site/"
cp "$SRC/os/emscripten/kimi.js" "$ROOT/site/"
touch "$ROOT/site/.nojekyll"

echo "==> Done. Serve locally with:  python3 -m http.server -d $ROOT/site 8000"
