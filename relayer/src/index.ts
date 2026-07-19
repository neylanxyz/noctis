import { watchLockedEvents } from "./ethereumWatcher.js";
import { mintShieldedWrapper, watchBurnEvents } from "./midnightClient.js";
import { submitUnlock } from "./ethereumUnlocker.js";

async function main() {
  watchLockedEvents(async (event) => {
    await mintShieldedWrapper(event);
  });

  await watchBurnEvents(async (redemptionId, to, amount) => {
    await submitUnlock({ to, amount, redemptionId });
  });

  console.log("[relayer] Noctis relayer running. Waiting for events...");
}

main().catch((error) => {
  console.error("[relayer] fatal error:", error);
  process.exit(1);
});
