# ethereum/

`contracts/NoctisLock.sol` - escrow contract. `deposit()` locks ETH and emits
`Locked(depositId, depositor, amount, midnightRecipient, nonce)` for the relayer to
observe. `unlock()` releases ETH given a relayer-signed attestation
(`keccak256(address(this), chainid, to, amount, redemptionId)`, eth-signed-message,
recovered against the on-chain `relayer` address). Replay-protected via
`processedRedemptions`.

## Commands

```
npm install
npm run build   # hardhat compile
npm test        # hardhat test - 5 passing
```

## Deploy locally (Hardhat node)

```
npx hardhat node   # in its own terminal, keep running
npx hardhat ignition deploy ignition/modules/NoctisLock.ts --network localhost \
  --parameters '{"NoctisLockModule":{"relayer":"<one of the node's printed addresses>"}}'
```

## Deploy to a public network (once you have an RPC URL + funded key)

```
npx hardhat keystore set SEPOLIA_RPC_URL
npx hardhat keystore set SEPOLIA_PRIVATE_KEY
npx hardhat ignition deploy ignition/modules/NoctisLock.ts --network sepolia --parameters '{"NoctisLockModule":{"relayer":"0xYOUR_RELAYER_ADDRESS"}}'
```

## Triggering a deposit

`scripts/deposit.ts` is a real, reusable way to call `deposit()` (not an ad hoc script) -
useful for demos and manual testing without a frontend:

```
npm run deposit -- <noctisLockAddress> <midnightRecipientHex> <amountEth> [depositorPrivateKey] [rpcUrl]
```

`midnightRecipientHex` comes from `npm run recipient-key` in `midnight/`. Defaults to
Hardhat's account #2 as depositor and `http://127.0.0.1:8545` as the RPC URL.

## Not yet done

- ERC20 support (ETH-only for now).
- Multisig relayer (contract currently trusts a single `relayer` address, owner-rotatable).
