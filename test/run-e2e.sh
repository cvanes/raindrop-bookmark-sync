#!/usr/bin/env bash
# End-to-end test: loads the extension into a disposable Microsoft Edge
# instance and runs test/e2e.mjs against a local mock of the Raindrop API.
# Requires: node 22+, openssl, Microsoft Edge (Chrome stable no longer honours
# --load-extension; override the browser with EDGE=/path/to/binary).
set -euo pipefail
cd "$(dirname "$0")"

EDGE="${EDGE:-/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge}"
EXT_DIR="$(cd .. && pwd)"
PROFILE="$(mktemp -d)"

if [ ! -f mock-key.pem ]; then
  openssl req -x509 -newkey rsa:2048 -keyout mock-key.pem -out mock-cert.pem \
    -days 30 -nodes -subj "/CN=api.raindrop.io" \
    -addext "subjectAltName=DNS:api.raindrop.io" 2>/dev/null
fi

node mock-raindrop.mjs &
MOCK_PID=$!

"$EDGE" \
  --user-data-dir="$PROFILE" \
  --load-extension="$EXT_DIR" \
  --remote-debugging-port=9223 \
  --proxy-server=127.0.0.1:8081 \
  --ignore-certificate-errors \
  --no-first-run --no-default-browser-check --disable-sync \
  --window-size=1200,900 about:blank > /dev/null 2>&1 &
EDGE_PID=$!

cleanup() {
  kill "$MOCK_PID" "$EDGE_PID" 2> /dev/null || true
  wait "$MOCK_PID" "$EDGE_PID" 2> /dev/null || true
  rm -rf "$PROFILE"
}
trap cleanup EXIT

sleep 6
node e2e.mjs
