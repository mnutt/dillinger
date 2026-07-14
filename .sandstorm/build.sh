#!/bin/bash
set -euo pipefail
# This script is run in the VM each time you run `vagrant-spk dev`.  This is
# the ideal place to invoke anything which is normally part of your app's build
# process - transforming the code in your repository into the collection of files
# which can actually run the service in production
#
# Some examples:
#
#   * For a C/C++ application, calling
#       ./configure && make && make install
#   * For a Python application, creating a virtualenv and installing
#     app-specific package dependencies:
#       virtualenv /opt/app/env
#       /opt/app/env/bin/pip install -r /opt/app/requirements.txt
#   * Building static assets from .less or .sass, or bundle and minify JS
#   * Collecting various build artifacts or assets into a deployment-ready
#     directory structure

cd /opt/app

# Keep development rebuilds reproducible without throwing away an already
# correct dependency tree. `npm ci` removes node_modules before reinstalling,
# so only run it when the dependency manifests or the Node/npm versions change.
# Set SANDSTORM_CLEAN_INSTALL=1 to force a clean install for a release build.
DEPENDENCY_STAMP="node_modules/.dillinger-sandstorm-dependencies"
DEPENDENCY_HASH="$({
  sha256sum package.json package-lock.json
  node --version
  npm --version
} | sha256sum | cut -d ' ' -f 1)"

if [[ "${SANDSTORM_CLEAN_INSTALL:-0}" == "1" ]] ||
  [[ ! -x node_modules/.bin/next ]] ||
  [[ ! -f "$DEPENDENCY_STAMP" ]] ||
  [[ "$(<"$DEPENDENCY_STAMP")" != "$DEPENDENCY_HASH" ]]; then
  npm ci --prefer-offline --no-audit --no-fund
  printf '%s\n' "$DEPENDENCY_HASH" > "$DEPENDENCY_STAMP"
else
  echo "Dependencies unchanged; reusing node_modules"
fi

# The public flag is compiled into the browser bundle and enables grain-backed
# persistence/UI. Linting runs separately; keep Next's production type-check.
NEXT_PUBLIC_SANDSTORM=1 NEXT_TELEMETRY_DISABLED=1 npm run build -- --no-lint

if [[ ! -f .next/server/app/index.html ]]; then
  echo "Sandstorm build requires a statically generated app/page.tsx" >&2
  exit 1
fi

# Build a dedicated grain runtime. This follows the statically generated
# editor's fingerprinted JS/CSS/font dependencies and copies only the public
# assets the editor actually serves. It deliberately does not package Next's
# standalone server or the static assets for the site's other routes.
node scripts/build-sandstorm-package.mjs
