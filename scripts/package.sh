#!/usr/bin/env bash
# Build a Chrome Web Store upload zip.
# The zip root contains manifest.json/src/icons (no wrapping folder), which is
# what the store expects. Output lands in dist/ (gitignored).
set -euo pipefail

cd "$(dirname "$0")/.."

version=$(node -e "process.stdout.write(require('./manifest.json').version)")
out="dist/raindrop-bookmark-sync-${version}.zip"

mkdir -p dist
rm -f "$out"

zip -r "$out" manifest.json src icons \
  -x '*.DS_Store'

echo "Packaged $out"
unzip -l "$out"
