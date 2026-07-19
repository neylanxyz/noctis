# Noctis

A privacy bridge: lock ETH on Ethereum, mint a shielded (private) representation of it
on Midnight, transact with it with zero metadata leakage, then burn-and-redeem back to
ETH. Midnight is used as a privacy layer for assets that originate on Ethereum.

**Status: the full round trip works end-to-end and has been exercised for real, both
directions** - a `deposit()` on a local Hardhat node was observed by the relayer,
which minted a real shielded coin on a local Midnight devnet (real ZK proof, confirmed
on-chain). That coin was then burned, and the relayer picked up the burn and called
`unlock()` on Ethereum for real - `NoctisLock`'s balance dropped by exactly the burned
amount and the recipient received exactly that amount. Everything runs with no
external network dependency (no Sepolia, no testnet faucet).

## Architecture

```
Ethereum                         Relayer                      Midnight
---------                        -------                      --------
NoctisLock.sol                   watches Locked events   ->   noctis-wrapper.compact
  deposit(recipient) locks ETH,                                 mint() proves relayer
  emits Locked(...)                                              identity, mints a
                                                                  shielded coin to
  unlock() releases ETH,    <-   watches processedBurns          `recipient`
  checks relayer signature         map, calls unlock()         burn() takes custody
                                                                  of the coin, records
                                                                  a redemptionId
```

`recipient` is the depositor's Midnight coin public key, encoded to 32 bytes via the
SDK's `encodeCoinPublicKey()` (see `midnight/src/printRecipientKey.ts`) - the depositor
computes this themselves before calling `deposit()`.

`burn()` takes the Ethereum recipient address as an explicit argument and reads the
coin's value itself (rather than trusting caller-supplied numbers), writing both into
a public `BurnRecord` in `processedBurns` - the relayer polls this map and acts only on
that canonical on-chain data, never on an out-of-band claim.

**Trust model:** this is a federated/attested bridge, not a trustless light-client
bridge (Midnight has no native Ethereum light client). The relayer is trusted to only
mint for deposits it actually observed on Ethereum, and to only unlock for burns it
actually observed on Midnight. For a hackathon this is the right scope; the natural
upgrade path is a 2-of-3 (or N-of-M) relayer multisig instead of a single key on both
sides.

## Status

- [x] `ethereum/` - `NoctisLock.sol`: deposit/lock + signature-gated unlock. 5/5 tests
      passing. Deployed and exercised against a real local Hardhat node, both `deposit`
      and `unlock` (unlock triggered live by the relayer, not just unit-tested).
- [x] `midnight/` - `noctis-wrapper.compact`: `mint`/`burn` circuits, both exercised
      with real ZK proofs against a real local devnet, confirmed on-chain. CLI supports
      both interactively (mint, and burn with coin selection from the wallet's owned
      shielded coins).
- [x] `relayer/` - full round trip verified live: a real Ethereum `deposit()` was
      picked up and minted on Midnight; that coin was burned, and the relayer picked up
      the burn and called `unlock()` on Ethereum, with `NoctisLock`'s balance and the
      recipient's balance both moving by exactly the burned amount.
- [ ] Testnet deployment: got partway through Midnight's `preview` testnet (wallet/seed
      persisted, deploy script ready) but blocked on the faucet not delivering funds -
      pivoted to proving everything out locally instead, see toolchain notes below for
      how to resume.
- [ ] Multisig relayer (stretch goal).
- [ ] `watchBurnEvents` polls contract state every 10s rather than using a push
      subscription - fine for a demo, would want a real indexer subscription (the
      indexer exposes a WS endpoint for this) for lower latency at scale.

## Real bugs found and fixed along the way

- **`mint()` circuit**: an early version called `sendImmediateShielded()` right after
  `mintShieldedToken()`, which fails ("attempted to spend a user-owned output as
  contract owned") - `mintShieldedToken(recipient=...)` already delivers the coin, the
  extra send was wrong. See `midnight/README.md`.
- **Cross-package dual-instance hazard**: `relayer/` and `midnight/` started as
  separate npm packages, each importing `@midnight-ntwrk/*` SDK packages. Since
  `relayer/src/midnightClient.ts` imports source files directly from `midnight/src/`,
  Node resolved singleton/WASM-backed packages (`midnight-js-network-id`,
  `onchain-runtime-v3`) to *two different physical copies* - one via each file's own
  directory-relative `node_modules` lookup - causing `setNetworkId()`/`getNetworkId()`
  to disagree, and later a WASM `instanceof` check (`expected instance of
  ChargedState`) to fail across the two copies. Fixed by converting the whole repo into
  an npm workspace (root `package.json` with `"workspaces"`) so there's exactly one
  physical copy of every dependency.
- **Wallet SDK coin shape vs. circuit coin shape mismatch**: the wallet's
  `availableCoins` returns `ledger.QualifiedShieldedCoinInfo` objects using that
  package's own field names/encoding (`type` as a hex *string*, not `color` as
  `Uint8Array`) - passing one directly into a compiled circuit's `burn()` call fails.
  Fixed with `encodeShieldedCoinInfo({ type, nonce, value })` (drops the
  Merkle-tree-index field `QualifiedShieldedCoinInfo` has and `ShieldedCoinInfo`
  doesn't, and produces the raw bytes shape the circuit expects) from
  `@midnight-ntwrk/midnight-js-protocol/ledger`.

## Folders

- `ethereum/` - Solidity lock/unlock contract (Hardhat 3, TypeScript, ethers.js).
- `midnight/` - Compact contract + devnet + deploy/CLI tooling for the shielded wrapper.
- `relayer/` - Node/TS service bridging the two chains.

This is an npm workspace - run `npm install` once from this top-level directory (not
inside each subfolder) and all three share a single `node_modules`. Each subfolder
still has its own `package.json`/scripts, run via `cd <folder> && npm run <script>`.

Each folder has its own README with setup/run instructions and design notes.

## Running it yourself (fully local)

```bash
# 1. Local Midnight devnet (needs Docker - see toolchain notes)
cd midnight
npm run devnet:up
npm run deploy              # prints the wrapper contract address
npm run recipient-key       # prints your Midnight coin public key as a bytes32 hex value

# 2. Local Ethereum node, in another terminal
cd ethereum
npx hardhat node            # keep running
# in a third terminal:
npx hardhat ignition deploy ignition/modules/NoctisLock.ts --network localhost \
  --parameters '{"NoctisLockModule":{"relayer":"<one of the hardhat node's printed addresses>"}}'

# 3. Configure and run the relayer
cd relayer
cp .env.example .env        # fill in ETH_RPC_URL=http://127.0.0.1:8545, the two
                             # deployed contract addresses, and a relayer ETH private
                             # key (one of Hardhat's printed test keys is fine locally)
npm run dev

# 4. Deposit - triggers the relayer to mint on Midnight
# call NoctisLock.deposit(<bytes32 from step 1's recipient-key>, {value: ...})

# 5. Burn - triggers the relayer to call unlock() on Ethereum
cd midnight
npm run cli   # option 4: pick a minted coin, give an Ethereum address to redeem to
```

## Toolchain

- Node v22+ - installed
- Compact compiler v0.31.1 - installed (`~/.local/bin/compact`, on PATH via `.bashrc`)
- Docker (v29.1.3) + `docker-compose-v2` - installed. Runs the local Midnight devnet
  (node + indexer + proof-server). **Not usable from Claude's own shell in this
  session** - that shell is a separate, more restricted process than your terminal and
  can't pick up the `docker` group membership or do interactive `sudo`; Docker commands
  (`npm run devnet:up`/`devnet:down` in `midnight/`) need to be run in your own
  terminal. Everything else (deploy, cli, the relayer, hardhat) was run and verified
  directly by Claude once the devnet containers were up, since those only need plain
  HTTP/WS access to `127.0.0.1`, not the Docker socket.
