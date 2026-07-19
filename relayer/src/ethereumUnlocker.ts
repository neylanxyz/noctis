import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ethers } from "ethers";
import { config } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const artifactPath = path.resolve(
  __dirname,
  "../../ethereum/artifacts/contracts/NoctisLock.sol/NoctisLock.json"
);
const { abi: noctisLockAbi } = JSON.parse(readFileSync(artifactPath, "utf-8"));

/**
 * Signs and submits an unlock() call to NoctisLock once a burn has been confirmed on
 * Midnight. Mirrors the hash construction NoctisLock.unlock() checks on-chain:
 *   keccak256(address(this), chainid, to, amount, redemptionId), eth-signed-message hash.
 */
export async function submitUnlock(params: {
  to: string;
  amount: bigint;
  redemptionId: string;
}): Promise<string> {
  const provider = new ethers.JsonRpcProvider(config.ethereum.rpcUrl);
  const relayerWallet = new ethers.Wallet(config.ethereum.relayerPrivateKey, provider);
  const contract = new ethers.Contract(config.ethereum.noctisLockAddress, noctisLockAbi, relayerWallet);

  const network = await provider.getNetwork();
  const messageHash = ethers.solidityPackedKeccak256(
    ["address", "uint256", "address", "uint256", "bytes32"],
    [config.ethereum.noctisLockAddress, network.chainId, params.to, params.amount, params.redemptionId]
  );
  const signature = await relayerWallet.signMessage(ethers.getBytes(messageHash));

  const tx = await contract.unlock(params.to, params.amount, params.redemptionId, signature);
  console.log(`[ethereumUnlocker] submitted unlock tx ${tx.hash}`);
  const receipt = await tx.wait();
  return receipt.hash;
}
