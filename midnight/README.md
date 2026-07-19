# midnight/

`contracts/noctis-wrapper.compact` - the shielded wrapper-token contract. Mints a
shielded coin per Ethereum deposit, burns (permanently custodies) it on redemption.

## Build

```
compact compile contracts/noctis-wrapper.compact managed/noctis-wrapper
```

Outputs to `managed/noctis-wrapper/`: `contract/index.d.ts` (+`.js`) is the generated
TypeScript API used by `@midnight-ntwrk/midnight-js-contracts`; `keys/` and `zkir/`
hold the prover/verifier keys and compiled circuits.

## Design notes (learned by compiling, not just reading docs)

- **No in-circuit external-signature verification.** `verifySignature` /
  `signData` / `signatureVerifyingKey` exist only in `@midnight-ntwrk/compact-runtime`
  (the off-chain TS layer), not as Compact-language builtins - `compact compile`
  reports `unbound identifier verifySignature`. So the contract can't verify an
  Ethereum-style ECDSA/BIP340 signature on-chain.
- **Idiomatic alternative: prove knowledge of a secret key.** Instead, `mint()` follows
  the same pattern as Midnight's own bulletin-board example: the relayer's public key
  is stored on-chain as `persistentHash(domainSep, secretKey)`, and the relayer proves
  it can reproduce that hash from a `witness relayerSecretKey()` it supplies locally.
  Only the actual key holder can construct a valid proof - functionally equivalent to
  "only the relayer can call mint()," without needing cross-curve signature checks.
- **Circuit parameters are private by default.** Any parameter used in a ledger
  operation (map insert/member, minting, sending) must be wrapped in `disclose(...)` or
  compilation fails with a "potential witness-value disclosure" error. This is
  deliberate - it forces you to explicitly opt in to revealing something on-chain.
- **Token API:** `mintShieldedToken(domainSep, value, nonce, recipient: Either<ZswapCoinPublicKey, ContractAddress>) -> ShieldedCoinInfo`,
  `sendImmediateShielded(coin, recipient, value)`, `receiveShielded(coin: ShieldedCoinInfo)`.
  Note `receiveShielded` takes `ShieldedCoinInfo`, not `QualifiedShieldedCoinInfo` (the
  latter adds a Merkle-tree index field and is what you get back when *reading* a coin
  you own, not what these functions expect as input).
- `burn()` doesn't literally destroy the coin (there's no on-chain incinerator); it has
  the contract call `receiveShielded` to take custody, and since no circuit here ever
  spends it back out, it's permanently unspendable - burned in effect.
- **Don't call `sendImmediateShielded` right after `mintShieldedToken`.** An early
  version of `mint()` did both, and it fails at proof time with "attempted to spend a
  user-owned output as contract owned": `mintShieldedToken(..., recipient)` already
  delivers the coin to `recipient` - `sendImmediateShielded` is for re-sending a coin
  the contract currently holds (e.g. from `receiveShielded`), not one just minted
  straight to a user.
- **`ZswapCoinPublicKey` circuit args need the raw encoded bytes, not the SDK's string
  type.** The wallet SDK's `coinPublicKey` is a `CoinPublicKey` (`= string`); passing it
  directly to a circuit expecting `ZswapCoinPublicKey { bytes: Bytes<32> }` fails with a
  type error. Convert with `encodeCoinPublicKey()` from
  `@midnight-ntwrk/midnight-js-protocol/ledger` first (confirmed to return exactly 32
  bytes) and wrap as `{ bytes: encodeCoinPublicKey(coinPublicKey) }`. See
  `src/printRecipientKey.ts`.
- **The wallet's own coin objects need re-encoding before you can pass them back into a
  circuit.** `wallet.state().shielded.availableCoins[i].coin` is a
  `ledger.QualifiedShieldedCoinInfo` - its field for the token type is called `type`
  (a hex *string*), not `color` (`Uint8Array`), which is what the compiled contract's
  `burn(coin: ShieldedCoinInfo, ...)` expects. Convert with
  `encodeShieldedCoinInfo({ type: coin.type, nonce: coin.nonce, value: coin.value })`
  (also drops `mt_index`, which `QualifiedShieldedCoinInfo` has and `ShieldedCoinInfo`
  doesn't) from `@midnight-ntwrk/midnight-js-protocol/ledger`.
- **Struct-typed ledger values work as expected**: `struct BurnRecord { amount: Uint<128>; ethRecipient: Bytes<20>; }`
  as a `Map<Bytes<32>, BurnRecord>` value type compiles and round-trips through the
  generated TS API cleanly (`ledger.processedBurns.lookup(id)` returns a plain
  `{ amount: bigint, ethRecipient: Uint8Array }` object). Struct construction syntax is
  `StructName { field: value, ... }`.

- **`tsc --noEmit` reports an error in `deploy.ts`/`cli.ts` on the `withWitnesses(...)` call**
  (`argument of type 'any' is not assignable to parameter of type 'never'`). This is a
  known SDK type-inference gap when a compiled contract module is loaded dynamically
  (`await import(...)`) rather than statically - `create-mn-app`'s own generated
  `hello-world` template has the identical issue, which is why its `build` script is
  `tsc --noEmit || true` (ours matches). `tsx` (esbuild-based) doesn't type-check, so it
  doesn't block actually running `deploy`/`cli`.

## App (devnet, deploy, CLI)

Adapted from the official `create-mn-app` scaffolder (used it to generate a throwaway
`hello-world` project just to harvest a working `docker-compose.yml` + deploy/wallet
code, then adapted both for this contract - see git history / session notes for
details).

```
npm install            # run once, from the repo root (this is an npm workspace)
npm run devnet:up      # docker compose up -d --wait: node + indexer + proof-server
npm run compile        # compact compile -> managed/noctis-wrapper
npm run deploy         # deploys, generates/persists a relayer key in .noctis-relayer-key,
                        # prints the contract address, saves it to .midnight-state.json
npm run cli             # interactive: mint a test coin to your own wallet, read ledger
                        # state (relayerPublicKey, processed counts), check balance
npm run recipient-key  # prints your wallet's coinPublicKey as the bytes32 hex value to
                        # pass into NoctisLock.deposit() on the Ethereum side
```

`mint()` requires a witness (`relayerSecretKey`) proving knowledge of the key behind
the on-chain `relayerPublicKey` commitment - `deploy.ts`/`cli.ts` generate and persist
this to `.noctis-relayer-key` on first run (or read it from
`RELAYER_MIDNIGHT_SECRET_KEY`). Back this file up; losing it means losing the ability
to mint against that deployed contract.

`src/network.ts`, `wallet.ts`, `wallet-state.ts` are network/wallet plumbing (seed
management, sync-state persistence, provider config for `undeployed`/`preview`/
`preprod`) - generic, not specific to this contract, and reused directly by
`relayer/src/midnightClient.ts` via relative import. This only works cleanly because
the whole repo is one npm workspace (single shared `node_modules`) - see the top-level
README's "two real bugs" section for what breaks if `relayer/` and `midnight/` have
separate `node_modules` trees instead.

**Verified working end-to-end, both circuits** (see top-level README for the full
round-trip): `mint()` exercised via both `npm run cli` and the relayer reacting to a
live Ethereum deposit; `burn()` exercised via both `npm run cli` (option 4, with real
coin selection from the wallet's `availableCoins`) and confirmed to trigger a real
`unlock()` on Ethereum via the relayer. All confirmed by reading `processedDeposits`/
`processedBurns` back out of contract state afterwards, not just by absence of errors.

## Not yet done

- Testnet (`preview`/`preprod`) deployment - got as far as a persisted wallet seed and
  a deploy attempt, blocked on the faucet not delivering funds. `npm run setup --
  --network preview` (or `preprod`) is ready to resume once that's sorted.
- Multisig relayer (N-of-M instead of a single `relayerPublicKey`) - stretch goal.
- No color/token-type filtering on `availableCoins` in `cli.ts`'s burn flow - lists
  whatever the wallet holds as shielded coins. Fine as long as the demo wallet only
  ever holds wrapped-ETH coins from this contract (true so far); would need filtering
  by token type before this wallet touches any other shielded asset.
