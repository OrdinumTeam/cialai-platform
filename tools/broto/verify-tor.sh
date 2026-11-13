#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail
version=15.0.22
fingerprint=EF6E286DDA85EA2A4BA7DE684E2C6E8793298290
base="https://archive.torproject.org/tor-package-archive/torbrowser/$version"
work=$(mktemp -d)
trap 'rm -r "$work"' EXIT
export GNUPGHOME="$work/gnupg"
mkdir -m 700 "$GNUPGHOME"
curl --fail --silent --show-error --location "https://keys.openpgp.org/vks/v1/by-fingerprint/$fingerprint" -o "$work/key.asc"
gpg --batch --import "$work/key.asc"
gpg --batch --with-colons --fingerprint "$fingerprint" | awk -F: -v expected="$fingerprint" '$1=="fpr" && $10==expected {found=1} END {exit !found}'
curl --fail --silent --show-error --location "$base/sha256sums-signed-build.txt" -o "$work/sums"
curl --fail --silent --show-error --location "$base/sha256sums-signed-build.txt.asc" -o "$work/sums.asc"
gpg --batch --verify "$work/sums.asc" "$work/sums"
node --input-type=module - "$work/sums" <<'JS'
import {readFileSync} from 'node:fs';
import {TOR_TARGETS} from './tools/fetch-tor.mjs';
const text=readFileSync(process.argv[2],'utf8');
for(const {archive,sha256} of Object.values(TOR_TARGETS)) {
 if(!text.split('\n').some(line=>line.trim().split(/\s+/)[0]===sha256 && line.trim().split(/\s+/)[1]?.replace(/^\*/, '')===archive)) throw Error(`Tor signed checksum differs: ${archive}`);
}
JS
