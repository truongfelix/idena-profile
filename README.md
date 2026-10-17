# idena-profile

An Idena WASM contract for profiles: one unique name, a short bio and a picture per identity, Trust (a public vouch
counted per person and per topic), and vouched members (a validated identity vouches for accounts that are not
validated yet, which may then hold a name, write a profile and give Trust). It runs on the Idena chain as it is
(consensus v12, no fork). It has no owner and no upgrade: nobody can change or stop it; a later version would live
at another address.

## Mainnet

| | |
|---|---|
| Contract | `0xd558483330925f169bbe692d8ea15b2faa83c17f` |
| Deployed | 2026-10-16, tx `0x4c6f896a1b45c67c71719d6f2b8b6057afa117375867bada6424dce5a3368286` |
| Source | commit `b49127a` of this repository |
| Code sha256 | `05719792d5386f7f02ec12d333d5cddf5bcfe5f6851d3a312d2647e346cd05aa` (56,779 bytes) |

The record of the deploy is `deploy/mainnet.json`.

## Check the deployed code

```
git checkout b49127a
npm ci
npx asb assembly/index.ts
sha256sum build/release/idena-profile.wasm
```

The sha256 is the one above (built with Node 20 and 24; AssemblyScript 0.27.37, idena-sdk-as 0.0.29, as pinned by
`package-lock.json`). Compare it with the code stored on chain: the deploy transaction's payload, or
`api.idena.io/api/Contract/<address>`'s `code`.

`scripts/check-deployed-build.sh` (after `npm ci`) builds the current source and compares it with this sha256; CI
runs it on every push to `main` and every pull request. It fails on any change to the contract's code: a new version
would be a new contract, with its own deployment record.

## The rules

- **Names:** a-z, 0-9 and `_`, 3 to 20 characters, one per address, kept with no renewal while the holder validates
  (Newbie, Verified, Human) or is vouched for. One name claimed per epoch; a dropped or renamed name stays blocked for
  2 epochs. No reserved names, no fee beyond the call's own.
- **Freeing a name:** a holder who may no longer hold it (not validated, not vouched for) can be challenged: the one
  who wants the name calls `challengeName` once in each of 3 epochs in a row; the third call gives it the name. A
  holder found in good standing ends that challenge, and a skipped epoch starts it again.
- **Profile:** a bio of at most 160 characters, stored in the contract, and a picture as an `ipfs://` reference
  (the apps store a still 256x256 WebP of at most 32 KB and refuse to show a larger one).
- **Trust:** given once per giver and target (an address, or a topic `r/<name>`), revocable with `untrust`. Newbie,
  Verified, Human, Suspended and Zombie identities may give it; the contract keeps the raw counts and the apps count
  only the givers still in those states.
- **Vouched members:** a validated identity offers a vouch to an account without an identity, which accepts it. At
  most 5 members for a Human, 3 for a Verified, 1 for a Newbie, at a time, and as many new vouches per epoch. A
  member's calls send about one more call's fee (25,000 gas at the network's minimum fee per gas), burned. It lasts
  while the voucher is validated; either may end it. A member who gets an identity acts on its own.
- **Identity states** are read from the node with a promise and kept for the rest of the epoch.

The storage layout (every key and value) is at the top of `assembly/index.ts`.

## Calls

Each call takes one JSON argument (`string` format). `_gas` (the callback's WASM gas) and `_keepGas` (the gas of
each earlier state read) are optional; the apps size them from a dry run.

| Method | Argument |
|---|---|
| `claimName`, `challengeName` | `{"name": "..."}` |
| `dropName` | none |
| `setProfile` | `{"bio": "...", "picture": "ipfs://..."}` (empty removes) |
| `trust`, `untrust` | `{"target": "0x..." or "r/topic"}` |
| `vouch`, `cancelOffer`, `endVouch` | `{"member": "0x..."}` (`endVouch` with `""`: the member leaves) |
| `acceptVouch`, `declineOffer` | `{"voucher": "0x..."}` |

Read with the node's `contract_readMap` and `contract_iterateMap` (`string` keys and values).

## Tests

- `node tests/runner.mjs`: every rule over epochs and identity states, on idena-contract-runner (a chain in memory
  running idena-go's contract VM, with test calls to set epochs and identity states).
- `node tests/devnet.mjs`: the main cases through real transactions on a private devnet.

## Scripts

- `scripts/deploy.py <node RPC URL> <deployer address>`: deploys the reviewed build from a node over its RPC (the
  node signs; checks the sha256, the account, a dry run; sends only after "deploy" is typed).
- `scripts/import-key.py`: gives a node an account's key from its export (hidden prompts).

## License

MIT, see `LICENSE`.
