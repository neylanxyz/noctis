/**
 * CLI for interacting with the deployed Noctis wrapper contract.
 * Adapted from create-mn-app's hello-world CLI.
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import * as crypto from 'node:crypto';

import { encodeCoinPublicKey, encodeShieldedCoinInfo } from '@midnight-ntwrk/midnight-js-protocol/ledger';
import { findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { resolveNetwork, getOrCreateSeed, getDeployment } from './network';
import { createWallet, persistWalletState, unshieldedToken, type WalletContext } from './wallet';
import { getOrCreateRelayerSecretKey } from './relayerKey';
import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/compact-js';
import { PRIVATE_STATE_ID, type NoctisPrivateState } from './contractTypes';
import type * as NoctisWrapperTypes from '../managed/noctis-wrapper/contract/index.js';
import type { WitnessContext } from '@midnight-ntwrk/compact-runtime';

// @ts-expect-error Required for wallet sync
globalThis.WebSocket = WebSocket;

const { network, config: networkConfig } = resolveNetwork();
const SEED = getOrCreateSeed(network);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const zkConfigPath = path.resolve(__dirname, '..', 'managed', 'noctis-wrapper');
const contractPath = path.join(zkConfigPath, 'contract', 'index.js');

if (!fs.existsSync(contractPath)) {
  console.error('\n❌ Contract not compiled! Run: npm run compile\n');
  process.exit(1);
}

const NoctisWrapper = await import(pathToFileURL(contractPath).href);
const relayerSecretKey = getOrCreateRelayerSecretKey();

const witnesses: NoctisWrapperTypes.Witnesses<NoctisPrivateState> = {
  relayerSecretKey: (context: WitnessContext<NoctisWrapperTypes.Ledger, NoctisPrivateState>): [NoctisPrivateState, Uint8Array] => [
    context.privateState,
    context.privateState.relayerSecretKey,
  ],
};

// as any: see comment in deploy.ts
const compiledContract = CompiledContract.make('noctis-wrapper', NoctisWrapper.Contract).pipe(
  CompiledContract.withWitnesses(witnesses as any),
  CompiledContract.withCompiledFileAssets(zkConfigPath),
);

async function createProviders(walletCtx: WalletContext) {
  const privateStatePassword = process.env.PRIVATE_STATE_PASSWORD?.trim() || 'Local-Devnet-Development-Placeholder-1';

  const walletProvider = {
    getCoinPublicKey: () => walletCtx.shieldedSecretKeys.coinPublicKey,
    getEncryptionPublicKey: () => walletCtx.shieldedSecretKeys.encryptionPublicKey,
    async balanceTx(tx: any, ttl?: Date) {
      const recipe = await walletCtx.wallet.balanceUnboundTransaction(
        tx,
        { shieldedSecretKeys: walletCtx.shieldedSecretKeys, dustSecretKey: walletCtx.dustSecretKey },
        { ttl: ttl ?? new Date(Date.now() + 30 * 60 * 1000) },
      );
      return walletCtx.wallet.finalizeRecipe(recipe);
    },
    submitTx: (tx: any) => walletCtx.wallet.submitTransaction(tx) as any,
  };

  const zkConfigProvider = new NodeZkConfigProvider(zkConfigPath);
  const accountId = walletCtx.unshieldedKeystore.getBech32Address().toString();

  return {
    privateStateProvider: levelPrivateStateProvider({
      privateStateStoreName: 'noctis-wrapper-state',
      accountId,
      privateStoragePasswordProvider: () => privateStatePassword,
    }),
    publicDataProvider: indexerPublicDataProvider(networkConfig.indexer, networkConfig.indexerWS),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(networkConfig.proofServer, zkConfigProvider),
    walletProvider,
    midnightProvider: walletProvider,
  };
}

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║                   Noctis wrapper CLI                            ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  const rl = createInterface({ input: stdin, output: stdout });

  const deployment = getDeployment(network);
  if (!deployment) {
    console.error(`No deploy on file for network ${network}. Run \`npm run deploy\` first.`);
    process.exit(1);
  }
  console.log(`  Contract: ${deployment.address}`);
  console.log(`  Network: ${network}\n`);

  try {
    const walletCtx = await createWallet({ network, networkConfig, seed: SEED });
    console.log('  Syncing with network...');
    const state = await walletCtx.wallet.waitForSyncedState();
    console.log('  ✓ Synced.\n');
    await persistWalletState(network, walletCtx);
    const balance = state.unshielded.balances[unshieldedToken().raw] ?? 0n;
    console.log(`  Balance: ${balance.toLocaleString()} tNight\n`);

    console.log('  Connecting to contract...');
    const providers = await createProviders(walletCtx);
    const deployed: any = await findDeployedContract(providers, {
      compiledContract: compiledContract as any,
      contractAddress: deployment.address,
      privateStateId: PRIVATE_STATE_ID,
      initialPrivateState: { relayerSecretKey } satisfies NoctisPrivateState,
    });
    console.log('  ✅ Connected!\n');

    let running = true;
    while (running) {
      console.log('─── Menu ───────────────────────────────────────────────────────');
      console.log('  1. Mint a test wrapped-ETH coin to your own wallet');
      console.log('  2. Read contract state (relayer key, processed counts)');
      console.log('  3. Check wallet balance');
      console.log('  4. Burn a wrapped-ETH coin (redeem to an Ethereum address)');
      console.log('  5. Exit\n');

      const choice = await rl.question('  Your choice: ');

      switch (choice.trim()) {
        case '1': {
          const amountStr = await rl.question('  Amount (integer, simulated wei->wrapped units): ');
          const amount = BigInt(amountStr.trim());
          const depositId = crypto.randomBytes(32);
          const nonce = crypto.randomBytes(32);
          // Circuit expects the raw encoded bytes wrapped as { bytes }, not the SDK's
          // string-typed CoinPublicKey directly.
          const recipient = { bytes: encodeCoinPublicKey(walletCtx.shieldedSecretKeys.coinPublicKey) };
          console.log('\n  Submitting mint transaction (this may take 30-60 seconds)...');
          try {
            const tx = await deployed.callTx.mint(depositId, amount, nonce, recipient);
            console.log(`\n  ✅ Minted. Transaction ID: ${tx.public.txId}`);
            console.log(`  Block height: ${tx.public.blockHeight}\n`);
          } catch (error) {
            console.error('\n  ❌ Failed:', error instanceof Error ? error.message : error);
          }
          break;
        }

        case '2': {
          console.log('\n  Reading contract state...');
          try {
            const contractState = await providers.publicDataProvider.queryContractState(deployment.address);
            if (contractState) {
              const ledgerState = NoctisWrapper.ledger(contractState.data);
              console.log(`\n  Relayer public key: ${Buffer.from(ledgerState.relayerPublicKey).toString('hex')}`);
              console.log(`  Processed deposits: ${ledgerState.processedDeposits.size()}`);
              console.log(`  Processed burns:    ${ledgerState.processedBurns.size()}\n`);
            } else {
              console.log('\n  No contract state found\n');
            }
          } catch (error) {
            console.error('\n  ❌ Failed:', error instanceof Error ? error.message : error);
          }
          break;
        }

        case '3': {
          const currentState = await walletCtx.wallet.waitForSyncedState();
          const currentBalance = currentState.unshielded.balances[unshieldedToken().raw] ?? 0n;
          const dustBalance = currentState.dust.balance(new Date());
          console.log(`\n  tNight: ${currentBalance.toLocaleString()}`);
          console.log(`  DUST: ${dustBalance.toLocaleString()}\n`);
          break;
        }

        case '4': {
          const available = (await walletCtx.wallet.waitForSyncedState()).shielded.availableCoins as any[];
          if (available.length === 0) {
            console.log('\n  No shielded coins available to burn. Mint one first (option 1).\n');
            break;
          }
          console.log('\n  Available coins:');
          available.forEach((c, i) => {
            console.log(`    ${i + 1}. value=${c.coin.value.toLocaleString()} type=${c.coin.type.slice(0, 16)}...`);
          });
          const pickStr = await rl.question(`  Pick a coin to burn [1-${available.length}]: `);
          const pick = available[Number(pickStr.trim()) - 1];
          if (!pick) {
            console.log('\n  Invalid selection.\n');
            break;
          }
          const ethAddrStr = await rl.question('  Ethereum address to redeem to (0x...): ');
          const ethRecipient = Uint8Array.from(Buffer.from(ethAddrStr.trim().replace(/^0x/, ''), 'hex'));
          if (ethRecipient.length !== 20) {
            console.log(`\n  Invalid Ethereum address - expected 20 bytes, got ${ethRecipient.length}.\n`);
            break;
          }
          const redemptionId = crypto.randomBytes(32);
          const shieldedCoinInfo = encodeShieldedCoinInfo({
            type: pick.coin.type,
            nonce: pick.coin.nonce,
            value: pick.coin.value,
          });
          console.log('\n  Submitting burn transaction (this may take 30-60 seconds)...');
          try {
            const tx = await deployed.callTx.burn(shieldedCoinInfo, redemptionId, ethRecipient);
            console.log(`\n  ✅ Burned. Transaction ID: ${tx.public.txId}`);
            console.log(`  Redemption ID: 0x${Buffer.from(redemptionId).toString('hex')}`);
            console.log('  The relayer will pick this up and call unlock() on Ethereum automatically.\n');
          } catch (error) {
            console.error('\n  ❌ Failed:', error instanceof Error ? error.message : error);
          }
          break;
        }

        case '5':
          running = false;
          console.log('\n  Goodbye!\n');
          break;

        default:
          console.log('\n  Invalid choice. Please enter 1-5.\n');
      }
    }

    await persistWalletState(network, walletCtx);
    await walletCtx.wallet.stop();
  } catch (error) {
    console.error('\n❌ Error:', error instanceof Error ? error.message : error);
  } finally {
    rl.close();
  }
}

main().catch(console.error);
