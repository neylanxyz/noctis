import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import type { LockedEvent } from './ethereumWatcher.js';

// Reuses midnight/'s network/wallet/key infra directly (sibling package in this repo)
// rather than duplicating it - see midnight/src/{network,wallet,relayerKey}.ts.
import { resolveNetwork, getOrCreateSeed } from '../../midnight/src/network.js';
import { createWallet, persistWalletState, type WalletContext } from '../../midnight/src/wallet.js';
import { getOrCreateRelayerSecretKey } from '../../midnight/src/relayerKey.js';
import { PRIVATE_STATE_ID, type NoctisPrivateState } from '../../midnight/src/contractTypes.js';

import { deployContract, findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/compact-js';
// setNetworkId here (not just relying on midnight/wallet.ts's own call) because
// relayer/ and midnight/ are separate npm packages with independently resolved
// node_modules: wallet.ts's import of @midnight-ntwrk/midnight-js-network-id resolves
// relative to *its own* file location (midnight/node_modules), while
// midnight-js-contracts (loaded from relayer/node_modules) reads the network ID from
// a different physical copy of that same package - a dual-package-hazard from
// importing sibling-package source files across separate dependency trees. Confirmed
// live: without this, deployed.callTx.mint() throws "Network ID has not been
// configured" even though wallet.ts's createWallet() already called setNetworkId.
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { config } from './config.js';

// @ts-expect-error Required for wallet sync
globalThis.WebSocket = WebSocket;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const zkConfigPath = path.resolve(__dirname, '../../midnight/managed/noctis-wrapper');
const contractPath = path.join(zkConfigPath, 'contract', 'index.js');
const relayerKeyDir = path.resolve(__dirname, '../../midnight');

let cachedClient: Promise<MidnightMintClient> | undefined;

interface MidnightMintClient {
  deployed: any;
  walletCtx: WalletContext;
  providers: { publicDataProvider: { queryContractState(address: string): Promise<any> } };
  contractAddress: string;
  NoctisWrapper: any;
}

async function createProviders(walletCtx: WalletContext, networkConfig: ReturnType<typeof resolveNetwork>['config'], zkConfigProvider: NodeZkConfigProvider<string>) {
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

/**
 * Connects the relayer's Midnight wallet to the already-deployed noctis-wrapper
 * contract. Reuses the same relayer secret key persisted by `midnight/` (via
 * RELAYER_MIDNIGHT_SECRET_KEY or .noctis-relayer-key) - it must match the
 * relayerPublicKey the contract was deployed with, or mint() will fail its
 * "caller is not the relayer" assertion.
 */
async function connect(): Promise<MidnightMintClient> {
  if (!fs.existsSync(contractPath)) {
    throw new Error(`Contract not compiled: ${contractPath}. Run \`npm run compile\` in midnight/.`);
  }
  if (!config.midnight.wrapperContractAddress) {
    throw new Error('NOCTIS_WRAPPER_CONTRACT_ADDRESS is not set - deploy the contract first (midnight/ npm run deploy).');
  }

  // MIDNIGHT_NETWORK overrides which network to connect to; otherwise falls back to
  // whatever midnight/.midnight-state.json has as its active network (shared file).
  const networkOverride = process.env.MIDNIGHT_NETWORK;
  const { network, config: networkConfig } = resolveNetwork(
    networkOverride ? { argv: [...process.argv, '--network', networkOverride] } : undefined,
  );
  setNetworkId(networkConfig.networkId);
  const seed = getOrCreateSeed(network, { cwd: relayerKeyDir });
  const relayerSecretKey = getOrCreateRelayerSecretKey({ cwd: relayerKeyDir });

  const NoctisWrapper = await import(pathToFileURL(contractPath).href);

  const witnesses = {
    relayerSecretKey: (context: { privateState: NoctisPrivateState }): [NoctisPrivateState, Uint8Array] => [
      context.privateState,
      context.privateState.relayerSecretKey,
    ],
  };

  const compiledContract = CompiledContract.make('noctis-wrapper', NoctisWrapper.Contract).pipe(
    CompiledContract.withWitnesses(witnesses as any),
    CompiledContract.withCompiledFileAssets(zkConfigPath),
  );

  const walletCtx = await createWallet({ network, networkConfig, seed, cwd: relayerKeyDir });
  await walletCtx.wallet.waitForSyncedState();
  await persistWalletState(network, walletCtx, relayerKeyDir);

  const zkConfigProvider = new NodeZkConfigProvider(zkConfigPath);
  const providers = await createProviders(walletCtx, networkConfig, zkConfigProvider);

  const deployed = await findDeployedContract(providers, {
    compiledContract: compiledContract as any,
    contractAddress: config.midnight.wrapperContractAddress,
    privateStateId: PRIVATE_STATE_ID,
    initialPrivateState: { relayerSecretKey } satisfies NoctisPrivateState,
  });

  return { deployed, walletCtx, providers, contractAddress: config.midnight.wrapperContractAddress, NoctisWrapper };
}

function getClient(): Promise<MidnightMintClient> {
  if (!cachedClient) cachedClient = connect();
  return cachedClient;
}

const UINT64_MAX = (1n << 64n) - 1n;

/**
 * Mints a shielded wrapped-ETH coin for a Locked event observed on Ethereum.
 *
 * `event.midnightRecipient` is the depositor-supplied bytes32 from
 * NoctisLock.deposit() - it must be the raw output of the Midnight SDK's
 * `encodeCoinPublicKey(coinPublicKey)` (confirmed to be exactly 32 bytes, matching
 * the circuit's `ZswapCoinPublicKey { bytes: Bytes<32> }`). Depositors compute this
 * themselves before calling deposit() - see midnight/src/printRecipientKey.ts.
 */
export async function mintShieldedWrapper(event: LockedEvent): Promise<void> {
  const { deployed } = await getClient();

  const depositId = Buffer.from(event.depositId.replace(/^0x/, ''), 'hex');
  const nonce = Buffer.from(event.txHash.replace(/^0x/, ''), 'hex').subarray(0, 32);
  const recipientBytes = Buffer.from(event.midnightRecipient.replace(/^0x/, ''), 'hex');
  if (recipientBytes.length !== 32) {
    throw new Error(`midnightRecipient must decode to 32 bytes, got ${recipientBytes.length} (deposit ${event.depositId})`);
  }
  const recipient = { bytes: Uint8Array.from(recipientBytes) };

  if (event.amount > UINT64_MAX) {
    throw new Error(`deposit amount ${event.amount} exceeds Uint<64> max - the mint circuit's amount field can't hold it (deposit ${event.depositId})`);
  }

  const tx = await deployed.callTx.mint(depositId, event.amount, nonce, recipient);
  console.log(`[midnightClient] minted for deposit ${event.depositId}, tx ${tx.public.txId}`);
}

const BURN_POLL_INTERVAL_MS = 10_000;

/**
 * Polls the wrapper contract's `processedBurns` ledger map for entries not yet seen,
 * and calls `onBurn` for each. Polling rather than a push subscription - simple,
 * robust to relayer restarts (just re-scans full map and skips already-seen ids), and
 * `processedBurns` is small (bounded by total redemptions, not chain activity).
 *
 * `amount` and `to` (the Ethereum recipient) come straight from the on-chain
 * BurnRecord the burn() circuit writes - not trusted out-of-band input - so the
 * relayer only ever acts on canonical contract state.
 */
export async function watchBurnEvents(
  onBurn: (redemptionId: string, to: string, amount: bigint) => Promise<void>
): Promise<void> {
  const { providers, contractAddress, NoctisWrapper } = await getClient();
  const seen = new Set<string>();

  const poll = async () => {
    const state = await providers.publicDataProvider.queryContractState(contractAddress);
    if (!state) return;
    const ledger = NoctisWrapper.ledger(state.data);
    for (const [redemptionIdBytes, record] of ledger.processedBurns) {
      const redemptionId = '0x' + Buffer.from(redemptionIdBytes).toString('hex');
      if (seen.has(redemptionId)) continue;
      seen.add(redemptionId);
      const to = '0x' + Buffer.from(record.ethRecipient).toString('hex');
      console.log(`[midnightClient] new burn observed: redemption ${redemptionId} -> ${to}, amount ${record.amount}`);
      try {
        await onBurn(redemptionId, to, record.amount);
      } catch (err) {
        console.error(`[midnightClient] onBurn failed for ${redemptionId}:`, err);
      }
    }
  };

  await poll();
  setInterval(() => {
    poll().catch((err) => console.error('[midnightClient] burn poll failed:', err));
  }, BURN_POLL_INTERVAL_MS);

  console.log(`[midnightClient] watching processedBurns on ${contractAddress} (poll every ${BURN_POLL_INTERVAL_MS / 1000}s)`);
}
