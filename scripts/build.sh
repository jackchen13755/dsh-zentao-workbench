#!/bin/bash
# Build dsh-zentao-workbench — no network, no npm install required.
#
#   host half     tsc → dist/**            (plugin entry, tools, CLI)
#   browser half  tsc → lib/.client-build/**, then scripts/bundle-client.mjs
#                 inlines it into the single lib/client.js the profile serves
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
TSC="node_modules/typescript/bin/tsc"
[ -x "$TSC" ] || TSC="$(command -v tsc || true)"
[ -n "$TSC" ] || { echo "build: no tsc found (npm i -D typescript)" >&2; exit 1; }

echo "=== host half ==="
node "$TSC" -p tsconfig.build.json
echo "=== browser half ==="
node "$TSC" -p tsconfig.client.build.json
node scripts/bundle-client.mjs
echo "=== done ==="
