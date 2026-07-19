import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ethers } from "ethers";
import { config } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Read the ABI straight from the Hardhat build artifact so the relayer never drifts
// out of sync with the deployed NoctisLock contract.
const artifactPath = path.resolve(
  __dirname,
  "../../ethereum/artifacts/contracts/NoctisLock.sol/NoctisLock.json"
);
const { abi: noctisLockAbi } = JSON.parse(readFileSync(artifactPath, "utf-8"));

export interface LockedEvent {
  depositId: string;
  depositor: string;
  amount: bigint;
  midnightRecipient: string;
  nonce: bigint;
  txHash: string;
}

export function watchLockedEvents(onLocked: (event: LockedEvent) => Promise<void>) {
  const provider = new ethers.JsonRpcProvider(config.ethereum.rpcUrl);
  const contract = new ethers.Contract(config.ethereum.noctisLockAddress, noctisLockAbi, provider);

  contract.on(
    "Locked",
    async (depositId, depositor, amount, midnightRecipient, nonce, event) => {
      const lockedEvent: LockedEvent = {
        depositId,
        depositor,
        amount,
        midnightRecipient,
        nonce,
        txHash: event.log.transactionHash,
      };
      console.log("[ethereumWatcher] Locked event observed:", lockedEvent);
      await onLocked(lockedEvent);
    }
  );

  console.log(`[ethereumWatcher] watching Locked events on ${config.ethereum.noctisLockAddress}`);
  return contract;
}
