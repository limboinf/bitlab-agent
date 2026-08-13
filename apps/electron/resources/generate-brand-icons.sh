#!/usr/bin/env bash
# Generate every Bitlab app icon asset from a single SVG or PNG source.
#
# Usage:
#   bun run icons:generate
#   bun run icons:generate apps/electron/resources/bitlab/bitlab-padded.png
#   ICON_MARK_SOURCE=apps/electron/resources/mark-source.png bun run icons:generate
#
# Defaults:
#   - Positional source defaults to apps/electron/resources/source.png
#   - In-app menu mark source (ICON_MARK_SOURCE or 2nd positional arg)
#     defaults to apps/electron/resources/mark-source.png.
#
# PNG sources preserve their alpha channel by default. Prepare the PNG with
# the desired macOS transparent outer padding before running this script.
#
# Required tools: bun, magick (ImageMagick), sips, iconutil.
# SVG inputs additionally require rsvg-convert.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
RESOURCES_DIR="$SCRIPT_DIR"
SOURCE_INPUT="${1:-$RESOURCES_DIR/source.png}"

if [[ "$SOURCE_INPUT" != /* ]]; then
  SOURCE_INPUT="$PWD/$SOURCE_INPUT"
fi

if [[ ! -f "$SOURCE_INPUT" ]]; then
  echo "Error: source image not found: $SOURCE_INPUT" >&2
  exit 1
fi

SOURCE_ASSET="$(cd "$(dirname "$SOURCE_INPUT")" && pwd)/$(basename "$SOURCE_INPUT")"
SOURCE_EXT="${SOURCE_ASSET##*.}"
SOURCE_EXT="$(printf '%s' "$SOURCE_EXT" | tr '[:upper:]' '[:lower:]')"
SOURCE_SVG=""
if [[ "$SOURCE_EXT" == "svg" ]]; then
  SOURCE_SVG="$SOURCE_ASSET"
fi

for command in magick sips iconutil bun; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Error: required command not found: $command" >&2
    exit 1
  fi
done

if [[ "$SOURCE_EXT" == "svg" ]] && ! command -v rsvg-convert >/dev/null 2>&1; then
  echo "Error: required command not found for SVG input: rsvg-convert" >&2
  exit 1
fi

copy_svg() {
  local target="$1"
  mkdir -p "$(dirname "$target")"
  if [[ "$SOURCE_SVG" != "$target" ]]; then
    cp "$SOURCE_SVG" "$target"
  fi
}

write_png_embedded_svg() {
  local target="$1"
  local source_png="$2"
  local title="$3"
  local size="$4"
  local png_data
  mkdir -p "$(dirname "$target")"
  png_data="$(base64 < "$source_png" | tr -d '\n')"
  cat > "$target" <<EOF
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 $size $size" role="img" aria-labelledby="title">
  <title id="title">$title</title>
  <image width="$size" height="$size" href="data:image/png;base64,$png_data"/>
</svg>
EOF
}

write_embedded_svg() {
  write_png_embedded_svg "$1" "$RESOURCES_DIR/source.png" "Bitlab" "1024"
}

write_embedded_svgs() {
  write_embedded_svg "$RESOURCES_DIR/icon.svg"
  write_embedded_svg "$RESOURCES_DIR/icon.icon/Assets/icon.svg"
  mkdir -p "$RESOURCES_DIR/tool-icons"
  write_embedded_svg "$RESOURCES_DIR/tool-icons/bitlab.svg"
  write_embedded_svg "$REPO_ROOT/apps/webui/src/public/favicon.svg"
}

echo "Using source image: $SOURCE_ASSET"

case "$SOURCE_EXT" in
  svg)
    copy_svg "$RESOURCES_DIR/icon.svg"
    copy_svg "$RESOURCES_DIR/icon.icon/Assets/icon.svg"
    mkdir -p "$RESOURCES_DIR/tool-icons"
    copy_svg "$RESOURCES_DIR/tool-icons/bitlab.svg"
    copy_svg "$REPO_ROOT/apps/webui/src/public/favicon.svg"
    ;;
  png)
    ;;
  *)
    echo "Error: unsupported source format .$SOURCE_EXT. Use SVG or PNG." >&2
    exit 1
    ;;
esac

# Avoid shipping a stale compiled asset catalog when the source SVG changes.
rm -f "$RESOURCES_DIR/Assets.car"

echo "Rendering source.png..."
if [[ "$SOURCE_EXT" == "svg" ]]; then
  rsvg-convert -w 1024 -h 1024 -f png "$SOURCE_ASSET" -o "$RESOURCES_DIR/source.png"
else
  # PNG source: normalize to 1024x1024 with transparent canvas if needed.
  magick "$SOURCE_ASSET" -resize 1024x1024 -background none -gravity center -extent 1024x1024 "$RESOURCES_DIR/source.png"
  write_embedded_svgs
fi

echo "Generating Electron platform icons (delegating to generate-icons.sh)..."
(
  cd "$RESOURCES_DIR"
  bash ./generate-icons.sh source.png
)

echo "Generating Windows ICO with ImageMagick..."
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
for size in 16 24 32 48 64 128 256; do
  magick "$RESOURCES_DIR/source.png" -alpha on -resize "${size}x${size}" "$TMP_DIR/icon_${size}.png"
done
magick \
  "$TMP_DIR/icon_16.png" \
  "$TMP_DIR/icon_24.png" \
  "$TMP_DIR/icon_32.png" \
  "$TMP_DIR/icon_48.png" \
  "$TMP_DIR/icon_64.png" \
  "$TMP_DIR/icon_128.png" \
  "$TMP_DIR/icon_256.png" \
  "$RESOURCES_DIR/icon.ico"

echo "Generating web icons..."
mkdir -p "$REPO_ROOT/apps/webui/src/public"
magick "$RESOURCES_DIR/source.png" -alpha on -resize 512x512 "$REPO_ROOT/apps/webui/src/public/icon-512.png"
magick "$RESOURCES_DIR/source.png" -alpha on -resize 192x192 "$REPO_ROOT/apps/webui/src/public/icon-192.png"
magick "$RESOURCES_DIR/source.png" -alpha on -resize 180x180 "$REPO_ROOT/apps/webui/src/public/apple-touch-icon.png"
magick "$RESOURCES_DIR/source.png" -alpha on -resize 16x16 "$TMP_DIR/favicon-16.png"
magick "$RESOURCES_DIR/source.png" -alpha on -resize 32x32 "$TMP_DIR/favicon-32.png"
magick "$RESOURCES_DIR/source.png" -alpha on -resize 48x48 "$TMP_DIR/favicon-48.png"
magick "$TMP_DIR/favicon-16.png" "$TMP_DIR/favicon-32.png" "$TMP_DIR/favicon-48.png" "$REPO_ROOT/apps/webui/src/public/favicon.ico"

echo "Generating renderer logo asset..."
mkdir -p "$REPO_ROOT/apps/electron/src/renderer/assets"
magick "$RESOURCES_DIR/source.png" -alpha on -resize 256x256 "$REPO_ROOT/apps/electron/src/renderer/assets/bitlab_app_icon.png"
write_png_embedded_svg "$REPO_ROOT/apps/electron/src/renderer/assets/bitlab_app_icon.svg" "$REPO_ROOT/apps/electron/src/renderer/assets/bitlab_app_icon.png" "Bitlab app icon" "256"

echo "Generating renderer mark asset..."
# Source selection priority:
#   1. ICON_MARK_SOURCE env var
#   2. 2nd positional arg
#   3. apps/electron/resources/mark-source.png
#
# The source must already be an isolated transparent mark. Trim its alpha
# bounds, fit it into the renderer canvas, and preserve its authored colors.
MARK_PNG="$REPO_ROOT/apps/electron/src/renderer/assets/bitlab_mark.png"
MARK_SVG="$REPO_ROOT/apps/electron/src/renderer/assets/bitlab_mark.svg"
MARK_SOURCE_INPUT="${ICON_MARK_SOURCE:-${2:-$RESOURCES_DIR/mark-source.png}}"
if [[ "$MARK_SOURCE_INPUT" != /* ]]; then
  MARK_SOURCE_INPUT="$PWD/$MARK_SOURCE_INPUT"
fi
if [[ ! -f "$MARK_SOURCE_INPUT" ]]; then
  echo "Error: mark source image not found: $MARK_SOURCE_INPUT" >&2
  exit 1
fi
magick "$MARK_SOURCE_INPUT" \
  -alpha on \
  -trim +repage \
  -resize 234x234 \
  -background none \
  -gravity center \
  -extent 256x256 \
  "$MARK_PNG"
write_png_embedded_svg "$MARK_SVG" "$MARK_PNG" "Bitlab mark" "256"

echo "Generating OAuth callback branding asset..."
magick "$MARK_PNG" -alpha on -resize 128x128 "$TMP_DIR/bitlab-mark-128.png"
cat > "$TMP_DIR/update-branding.cjs" <<'EOF'
const fs = require("fs");

const path = "packages/shared/src/branding.ts";
const dataUri = process.env.BRANDING_DATA_URI;
let source = fs.readFileSync(path, "utf8");
source = source.replace(
  /export const BITLAB_MARK_IMAGE_DATA_URI = (?:'data:image\/png;base64,[^']*'|);/,
  `export const BITLAB_MARK_IMAGE_DATA_URI = '${dataUri}';`,
);
fs.writeFileSync(path, source);
EOF
BRANDING_DATA_URI="data:image/png;base64,$(base64 < "$TMP_DIR/bitlab-mark-128.png" | tr -d '\n')" bun "$TMP_DIR/update-branding.cjs"

echo "Copying Electron resources to dist..."
(
  cd "$REPO_ROOT"
  bun run electron:build:assets
)

echo ""
echo "Generated brand icon assets from:"
echo "  $SOURCE_ASSET"
echo "Generated in-app mark asset from:"
echo "  $MARK_SOURCE_INPUT"
