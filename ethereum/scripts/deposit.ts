/**
 * Calls NoctisLock.deposit() - a real, reusable way to trigger the bridge for demos
 * and manual testing (rather than an ad hoc script). Reads the ABI from the compiled
 * artifact so it never drifts from the deployed contract.
 *
 * Usage:
 *   npx tsx scripts/deposit.ts <noctisLockAddress> <midnightRecipientHex> <amountEth> [depositorPrivateKey] [rpcUrl]
 *
 * midnightRecipientHex: 0x-prefixed 32-byte hex from `npm run recipient-key` in midnight/.
 * depositorPrivateKey defaults to Hardhat's account #2 (0x3C44...293BC), distinct from
 * the deployer (#0) and relayer (#1) used elsewhere in this demo.
 * rpcUrl defaults to the local Hardhat node (http://127.0.0.1:8545).
 */
import { ethers } from "ethers";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_DEPOSITOR_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
const DEFAULT_RPC_URL = "http://127.0.0.1:8545";

async function main() {
  const [noctisLockAddress, midnightRecipient, amountEth, depositorKey, rpcUrl] = process.argv.slice(2);

  if (!noctisLockAddress || !midnightRecipient || !amountEth) {
    console.error(
      "Usage: npx tsx scripts/deposit.ts <noctisLockAddress> <midnightRecipientHex> <amountEth> [depositorPrivateKey] [rpcUrl]",
    );
    process.exit(1);
  }

  const abi = JSON.parse(
    readFileSync(
      path.resolve(__dirname, "..", "artifacts", "contracts", "NoctisLock.sol", "NoctisLock.json"),
      "utf-8",
    ),
  ).abi;

  const provider = new ethers.JsonRpcProvider(rpcUrl ?? DEFAULT_RPC_URL);
  const depositor = new ethers.Wallet(depositorKey ?? DEFAULT_DEPOSITOR_KEY, provider);
  const noctisLock = new ethers.Contract(noctisLockAddress, abi, depositor);

  console.log(`Depositing ${amountEth} ETH from ${depositor.address}`);
  console.log(`  NoctisLock: ${noctisLockAddress}`);
  console.log(`  Midnight recipient: ${midnightRecipient}`);

  const tx = await noctisLock.deposit(midnightRecipient, { value: ethers.parseEther(amountEth) });
  console.log(`\nSubmitted: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`Confirmed in block ${receipt?.blockNumber}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
