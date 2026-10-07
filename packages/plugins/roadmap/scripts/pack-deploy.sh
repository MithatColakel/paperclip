#!/bin/bash
# Packs the built Roadmap plugin for a server: package.json without workspace
# dependencies (the worker bundle is self-contained; the UI bundle uses the
# host's React and plugin SDK) and dist/ without source maps. v0.1 has no
# database migrations.
#
#   scripts/pack-deploy.sh
#
# Output: dist-deploy/roadmap-plugin-<version>.tgz with a top-level roadmap/
# directory, ready to copy into the server's data volume (for example
# /paperclip/plugin-sources/roadmap) and install with
#   POST /api/plugins/install {"packageName": "<dir>", "isLocalPath": true}
set -euo pipefail

PLUGIN="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(node -p "require('$PLUGIN/package.json').version")"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

echo "==> Checking plugin $VERSION"
(cd "$PLUGIN" && node ./scripts/check-tokens.ts)

echo "==> Building plugin $VERSION"
(cd "$PLUGIN" && node ./esbuild.config.mjs)

MANIFEST_VERSION="$(cd "$PLUGIN" && node --input-type=module -e "import('./dist/manifest.js').then((m) => console.log(m.default.version))")"
if [ "$MANIFEST_VERSION" != "$VERSION" ]; then
  echo "package.json is $VERSION but the manifest says $MANIFEST_VERSION; bump both." >&2
  exit 1
fi

OUT="$STAGE/roadmap"
mkdir -p "$OUT/dist"
rsync -a --exclude '*.map' "$PLUGIN/dist/" "$OUT/dist/"
cp "$PLUGIN/README.md" "$OUT/README.md"
node -e '
const pkg = require(process.argv[1]);
const out = { name: pkg.name, version: pkg.version, description: pkg.description, type: "module", private: true,
  license: pkg.license, paperclipPlugin: pkg.paperclipPlugin, engines: pkg.engines };
require("fs").writeFileSync(process.argv[2], JSON.stringify(out, null, 2) + "\n");
' "$PLUGIN/package.json" "$OUT/package.json"

mkdir -p "$PLUGIN/dist-deploy"
TARBALL="$PLUGIN/dist-deploy/roadmap-plugin-$VERSION.tgz"
COPYFILE_DISABLE=1 tar -C "$STAGE" -czf "$TARBALL" roadmap
echo "==> $TARBALL ($(du -h "$TARBALL" | cut -f1))"
tar -tzf "$TARBALL" | sed 's/^/    /' | head -20
