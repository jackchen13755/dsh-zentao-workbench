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
VERSION="${REACT_VERSION:-18.3.1}"

# Both UMD files come from the registry: the harness must not depend on any
# third-party plugin tree on this machine (an earlier version read React out of
# a vendor directory, which made the harness break the moment that plugin was
# removed). Set REACT_SRC=<dir with react*.production.min.js> to use local copies.
mkdir -p vendor
fetch_umd() {
  local pkg="$1" file="$2"
  if [ -n "${REACT_SRC:-}" ] && [ -f "$REACT_SRC/$file" ]; then
    cp -f "$REACT_SRC/$file" "vendor/$file"
    return
  fi
  echo "取 $pkg@$VERSION 的 $file…"
  curl -sSL --max-time 60 "https://registry.npmjs.org/$pkg/-/$pkg-$VERSION.tgz" \
    | tar -xzO "package/umd/$file" > "vendor/$file"
}
[ -f vendor/react.production.min.js ] || fetch_umd react react.production.min.js
[ -f vendor/react-dom.production.min.js ] || fetch_umd react-dom react-dom.production.min.js
cp -f ../../lib/client.js vendor/client.js
ls -la vendor | awk '{print "  ", $5, $9}'
echo "harness ready: tests/browser-harness/index.html"
