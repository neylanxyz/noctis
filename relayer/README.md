# relayer/

Node/TS service bridging Ethereum `Locked` events to Midnight `mint` calls, and Midnight
`burn` records back to Ethereum `unlock()` calls.

## Status

- `src/ethereumWatcher.ts` - watches `NoctisLock.Locked` events. Implemented, reads the
  ABI straight from the Hardhat build artifact.
- `src/ethereumUnlocker.ts` - signs and submits `NoctisLock.unlock()`. Unit-tested and
  **verified live**: driven by a real burn, its `unlock()` tx succeeded on-chain and
  moved exactly the burned amount from `NoctisLock` to the recipient.
- `src/midnightClient.ts` - `mintShieldedWrapper` and `watchBurnEvents` both connect to
  the deployed noctis-wrapper contract via the real `@midnight-ntwrk/midnight-js-contracts`
  SDK. **Verified working live, both directions**: a real `deposit()` on a local
  Hardhat node was picked up and correctly minted a shielded coin (real ZK proof,
  confirmed on-chain); a burn of that coin was picked up by `watchBurnEvents` (polls
  `processedBurns` every 10s) and correctly triggered `unlock()` on Ethereum.

## Setup

This is part of an npm workspace - run `npm install` once from the repo root, not here.

```
cp .env.example .env   # fill in ETH_RPC_URL, NOCTIS_LOCK_ADDRESS, keys,
                        # NOCTIS_WRAPPER_CONTRACT_ADDRESS (from midnight/ `npm run deploy`)
npm run dev
```

Use a dedicated key for `RELAYER_ETH_PRIVATE_KEY` (signs unlock attestations) - never a
personal wallet; for a local Hardhat node, one of its own printed test keys is fine.
`midnightClient.ts` reuses the same relayer secret key as `midnight/`
(`RELAYER_MIDNIGHT_SECRET_KEY` env var, or `midnight/.noctis-relayer-key`) - it must be
the same key the contract was deployed with, or `mint()` fails its relayer-identity check.
`MIDNIGHT_NETWORK` selects which network to connect to (defaults to whatever
`midnight/.midnight-state.json` has as its active network).

## Gotchas hit and fixed here (see top-level README for the full writeup)

- `ZswapCoinPublicKey` recipient args need `{ bytes: encodeCoinPublicKey(coinPublicKey) }`,
  not the wallet SDK's raw string `CoinPublicKey`.
- Amounts must fit `Uint<64>` - `mintShieldedWrapper` throws early with a clear message
  if `event.amount` exceeds it, rather than failing obscurely at proof time.
- `setNetworkId()` needs to be called explicitly in this package too (not just relied
  on via `midnight/wallet.ts`'s own call) - see the dual-package-hazard note in the
  top-level README. This is why the repo is an npm workspace now.
- `watchBurnEvents` trusts only on-chain data: `amount` and the Ethereum `to` address
  come from the contract's `BurnRecord` (which `burn()` populates from the coin's own
  value, not a caller-supplied number), not from any out-of-band message - so a
  malicious client can't trick the relayer into releasing more/less than was actually
  burned, or to the wrong address.
