// Shared, side-effect-free constants/types for the noctis-wrapper contract.
// Split out of deploy.ts because deploy.ts runs a full deployment as a module-level
// side effect (main().catch(...)) - importing from it would trigger a deploy.

export const PRIVATE_STATE_ID = 'noctisWrapperPrivateState';

export interface NoctisPrivateState {
  relayerSecretKey: Uint8Array;
}
