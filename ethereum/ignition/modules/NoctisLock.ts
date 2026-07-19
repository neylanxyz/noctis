import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

export default buildModule("NoctisLockModule", (m) => {
  const relayer = m.getParameter("relayer");
  const noctisLock = m.contract("NoctisLock", [relayer]);

  return { noctisLock };
});
