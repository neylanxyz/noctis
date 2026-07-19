/**
 * Prints the current wallet's Midnight coin public key, encoded as the raw bytes32
 * hex value that should be passed as `midnightRecipient` to NoctisLock.deposit() on
 * Ethereum. Run this BEFORE depositing - the relayer mints the wrapped coin to
 * whatever recipient value the deposit tx carried, and there's no way to change it
 * after the fact.
 *
 * Usage: npx tsx src/printRecipientKey.ts [--network undeployed|preview|preprod]
 */
import { WebSocket } from 'ws';
import { encodeCoinPublicKey } from '@midnight-ntwrk/midnight-js-protocol/ledger';
import { resolveNetwork, getOrCreateSeed } from './network.js';
import { createWallet } from './wallet.js';

// @ts-expect-error Required for wallet sync
globalThis.WebSocket = WebSocket;

const { network, config: networkConfig } = resolveNetwork();
const seed = getOrCreateSeed(network);

const walletCtx = await createWallet({ network, networkConfig, seed });
await walletCtx.wallet.waitForSyncedState();

const bytes = encodeCoinPublicKey(walletCtx.shieldedSecretKeys.coinPublicKey);
const hex = '0x' + Buffer.from(bytes).toString('hex');

console.log(`\nMidnight coin public key (network: ${network}):`);
console.log(`  ${walletCtx.shieldedSecretKeys.coinPublicKey}\n`);
console.log('Pass this as midnightRecipient to NoctisLock.deposit():');
console.log(`  ${hex}\n`);

await walletCtx.wallet.stop();
