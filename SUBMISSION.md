# Noctis

A privacy bridge between Ethereum and Midnight: lock ETH, mint a shielded
representation of it on Midnight, transact with zero metadata leakage, then burn to
redeem back to ETH.

## Inspiration

Midnight Network brought real zero-knowledge privacy to smart contracts, but almost
every asset worth protecting — ETH, stablecoins, DeFi positions — still lives on
transparent chains like Ethereum, where every balance, transfer, and counterparty is
public. We wanted to see what happens when you actually connect the two: not a generic
"cross-chain messaging" demo, but a working pipe that lets a real ETH holder get real
privacy without leaving the Ethereum ecosystem behind.

## What it does

Noctis lets you lock ETH on Ethereum and mint a shielded, private representation of it
on Midnight. Once minted, the wrapped ETH is a Zswap shielded coin — transfers hide
sender, receiver, and amount, unlike a typical wrapped-asset bridge where the wrapped
token is just as transparent as the original. When you're done, you burn the shielded
coin and get the original ETH released back to any Ethereum address you choose. The
round trip — **deposit → mint → transact privately → burn → unlock** — is fully
automated by a relayer watching both chains.

## How we built it

Three pieces, wired together end-to-end:

- **`NoctisLock.sol`** (Solidity/Hardhat) — an escrow contract on Ethereum. `deposit()`
  locks ETH and records the depositor's Midnight recipient key; `unlock()` releases ETH
  against a relayer signature, replay-protected.
- **`noctis-wrapper.compact`** (Compact) — the Midnight-side contract. `mint()` proves
  the relayer's identity (via a secret-key commitment, Midnight's idiomatic pattern
  rather than an on-chain signature check) and mints a shielded coin; `burn()` takes
  custody of a coin and records a public redemption — amount and destination taken
  straight from the coin itself, never trusted from an off-chain claim.
- **A Node/TS relayer** — watches Ethereum `Locked` events and mints on Midnight; polls
  the wrapper contract's redemption records and calls `unlock()` on Ethereum.

Everything runs against a real local devnet: a Dockerized Midnight node/indexer/proof
server, and a local Hardhat Ethereum node — no testnet dependency to demo it.

## Challenges we ran into

- **Compact has no in-circuit signature verification.** `verifySignature` turned out to
  be a TypeScript-runtime function, not a circuit primitive — so "verify the relayer's
  Ethereum-style signature on-chain" isn't possible. We redesigned around Midnight's
  actual idiom instead: the relayer proves knowledge of a secret key matching an
  on-chain commitment.
- **A redundant mint step.** An early version of `mint()` called
  `sendImmediateShielded()` right after `mintShieldedToken()` — which fails, because
  minting with a recipient already delivers the coin.
- **A silent dual-package hazard.** With the relayer and the Midnight app as separate
  npm packages, Node resolved singleton and WASM-backed SDK packages to two different
  physical copies — `setNetworkId()` in one was invisible to `getNetworkId()` in the
  other, and a WASM `instanceof` check failed the same way. Fixed by converting the
  whole repo into a single npm workspace.
- **SDK encoding mismatches.** The wallet's own coin objects and coin public keys
  aren't in the raw byte shape circuits expect — needed the right `encode*` helpers,
  found by reading real type definitions rather than guessing.
- **The testnet faucet wouldn't cooperate.** After getting partway through a `preview`
  testnet deployment, we pivoted to proving the entire flow out locally instead — which
  turned out to be the better demo anyway: fully reproducible, no external dependency,
  no waiting on faucets.

## Accomplishments that we're proud of

The whole thing actually works, verified live, not just claimed: a real `deposit()` on
Ethereum was picked up by the relayer, minted a real shielded coin on Midnight with a
genuine ZK proof, and that coin was burned and triggered a real `unlock()` back on
Ethereum — with `NoctisLock`'s balance and the recipient's balance both moving by
exactly the redeemed amount. Every bug above was caught by actually running the system
end-to-end, not by inspection.

## What we learned

Midnight's privacy model is enforced at the language level — every circuit parameter
is private by default, and touching public ledger state requires an explicit
`disclose()`. That's a deliberate, well-designed forcing function, and it changes how
you think about contract design from the first line. We also learned that a lot of
"official" tooling documentation lags the SDK's actual surface, and that the fastest
path to a working integration was often to scaffold with the real CLI tools, read
generated type definitions, and let the compiler's own error messages narrow down the
correct API — not to guess from docs alone.

## What's next for Noctis

- A multisig relayer (N-of-M signers) instead of a single trusted key on both sides.
- Real testnet and eventually mainnet deployment.
- A push-based indexer subscription for burn detection instead of polling.
- Token-type filtering in the wallet coin picker, so the bridge can safely coexist with
  other shielded assets in the same wallet.
- ERC-20 support alongside ETH, so stablecoins and other tokens get the same privacy
  layer.
