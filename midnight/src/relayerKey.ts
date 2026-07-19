// The relayer's Midnight-side secret key: a witness value proving "I am the
// relayer" to the noctis-wrapper contract's mint() circuit (see
// contracts/noctis-wrapper.compact - it checks
// derivePublicKey(relayerSecretKey()) == relayerPublicKey). Persisted locally,
// never sent on-chain - only its public-key commitment
// (pureCircuits.derivePublicKey) is.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

const KEY_FILE_NAME = '.noctis-relayer-key';

export interface FsOptions {
  cwd?: string;
}

function keyPath(opts: FsOptions = {}): string {
  return path.join(opts.cwd ?? process.cwd(), KEY_FILE_NAME);
}

/** Loads the persisted relayer secret key, generating and persisting one if absent. */
export function getOrCreateRelayerSecretKey(opts: FsOptions = {}): Uint8Array {
  const fromEnv = process.env.RELAYER_MIDNIGHT_SECRET_KEY;
  if (fromEnv) return Uint8Array.from(Buffer.from(fromEnv, 'hex'));

  const p = keyPath(opts);
  if (fs.existsSync(p)) {
    return Uint8Array.from(Buffer.from(fs.readFileSync(p, 'utf-8').trim(), 'hex'));
  }

  const key = crypto.randomBytes(32);
  fs.writeFileSync(p, key.toString('hex') + '\n');
  return Uint8Array.from(key);
}
