#!/bin/bash
# Builds the contract from this source and checks it is, byte for byte, the code deployed on mainnet: its sha256
# against deploy/mainnet.json. Run from anywhere, after `npm ci`. The contract on mainnet can never change, so a
# change to the source fails this check until it is deployed as a new contract with its own record.
set -euo pipefail
cd "$(dirname "$0")/.."
npx asb assembly/index.ts
expected=$(node -e 'console.log(require("./deploy/mainnet.json").sha256)')
actual=$(sha256sum build/release/idena-profile.wasm | cut -d' ' -f1)
echo "deployed: $expected"
echo "built:    $actual"
if [ "$actual" != "$expected" ]; then
  echo "The source does not build the contract deployed on mainnet." >&2
  exit 1
fi
echo "The source builds the contract deployed on mainnet."
