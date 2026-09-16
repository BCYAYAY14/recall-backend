#!/bin/sh
# Regenerates fixtures/isnewer.json from a Recall checkout's ISODate.swift.
# usage: tools/fixtures/gen-isnewer.sh /path/to/Recall
set -eu
RECALL="${1:?path to the Recall repository}"
DIR=$(mktemp -d)
cp "$(dirname "$0")/gen-isnewer.swift" "$DIR/main.swift"
swiftc -o "$DIR/gen" "$RECALL/Sources/Core/ISODate.swift" "$DIR/main.swift"
"$DIR/gen" > "$(dirname "$0")/../../fixtures/isnewer.json"
rm -rf "$DIR"
