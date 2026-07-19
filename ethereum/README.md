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

## Deploy (once you have a Sepolia RPC URL + funded key)

```
npx hardhat keystore set SEPOLIA_RPC_URL
npx hardhat keystore set SEPOLIA_PRIVATE_KEY
npx hardhat ignition deploy ignition/modules/NoctisLock.ts --network sepolia --parameters '{"NoctisLockModule":{"relayer":"0xYOUR_RELAYER_ADDRESS"}}'
```

## Not yet done

- ERC20 support (ETH-only for now).
- Multisig relayer (contract currently trusts a single `relayer` address, owner-rotatable).
