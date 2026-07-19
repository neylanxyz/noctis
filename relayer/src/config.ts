import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

export const config = {
  ethereum: {
    rpcUrl: required("ETH_RPC_URL"),
    noctisLockAddress: required("NOCTIS_LOCK_ADDRESS"),
    relayerPrivateKey: required("RELAYER_ETH_PRIVATE_KEY"),
  },
  midnight: {
    // Network selection (undeployed/preview/preprod) and indexer/node/proof-server
    // URLs are resolved via midnight/src/network.ts (see midnightClient.ts) - not
    // duplicated here.
    wrapperContractAddress: process.env.NOCTIS_WRAPPER_CONTRACT_ADDRESS ?? "",
  },
};
