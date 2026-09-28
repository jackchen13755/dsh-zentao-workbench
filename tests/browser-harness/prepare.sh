#!/bin/bash
# Assemble the browser harness: real React + our compiled client bundle.
#
# Why this exists: the panel normally only renders inside the DSH shell, which
# needs a host restart to pick up a newly wired plugin. This page mounts the very
# same bundle with the very same module-loader contract against a stub host, so
# the client half can be exercised in a real browser (and screenshotted) before
# any restart.
set -euo pipefail
cd "$(dirname "$0")"
VENDOR_SRC="${REACT_SRC:-$HOME/.dsh/vendor/dsh-zentao/node_modules/react/umd}"
VERSION="${REACT_VERSION:-18.3.1}"

mkdir -p vendor
cp -f "$VENDOR_SRC/react.production.min.js" vendor/react.production.min.js
if [ ! -f vendor/react-dom.production.min.js ]; then
  echo "vendor/react-dom.production.min.js 不存在，从 registry 取 react-dom@$VERSION 的 UMD…"
  curl -sSL --max-time 60 "https://registry.npmjs.org/react-dom/-/react-dom-$VERSION.tgz" \
    | tar -xzO "package/umd/react-dom.production.min.js" > vendor/react-dom.production.min.js
fi
cp -f ../../lib/client.js vendor/client.js
ls -la vendor | awk '{print "  ", $5, $9}'
echo "harness ready: tests/browser-harness/index.html"
