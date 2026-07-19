import { expect } from "chai";
import { network } from "hardhat";

const { ethers } = await network.connect();

describe("NoctisLock", () => {
  async function deployFixture() {
    const [owner, depositor, other] = await ethers.getSigners();
    const relayerWallet = ethers.Wallet.createRandom().connect(ethers.provider);

    // Fund the relayer wallet so it could pay gas if it ever needed to (not required to sign).
    await owner.sendTransaction({ to: relayerWallet.address, value: ethers.parseEther("1") });

    const NoctisLock = await ethers.getContractFactory("NoctisLock");
    const noctisLock = await NoctisLock.deploy(relayerWallet.address);
    await noctisLock.waitForDeployment();

    return { owner, depositor, other, relayerWallet, noctisLock };
  }

  it("locks ETH and emits Locked with an increasing nonce", async () => {
    const { depositor, noctisLock } = await deployFixture();
    const midnightRecipient = ethers.keccak256(ethers.toUtf8Bytes("midnight-shielded-address"));

    await expect(
      noctisLock.connect(depositor).deposit(midnightRecipient, { value: ethers.parseEther("1") })
    )
      .to.emit(noctisLock, "Locked")
      .withArgs(
        (depositId: string) => depositId.length === 66,
        depositor.address,
        ethers.parseEther("1"),
        midnightRecipient,
        0n
      );

    expect(await noctisLock.depositNonce()).to.equal(1n);
    expect(await ethers.provider.getBalance(await noctisLock.getAddress())).to.equal(
      ethers.parseEther("1")
    );
  });

  it("rejects zero-value deposits", async () => {
    const { depositor, noctisLock } = await deployFixture();
    const midnightRecipient = ethers.keccak256(ethers.toUtf8Bytes("recipient"));
    await expect(
      noctisLock.connect(depositor).deposit(midnightRecipient, { value: 0 })
    ).to.be.revertedWith("deposit amount must be > 0");
  });

  it("unlocks ETH given a valid relayer signature", async () => {
    const { depositor, other, relayerWallet, noctisLock } = await deployFixture();
    const midnightRecipient = ethers.keccak256(ethers.toUtf8Bytes("recipient"));
    await noctisLock.connect(depositor).deposit(midnightRecipient, { value: ethers.parseEther("2") });

    const redemptionId = ethers.keccak256(ethers.toUtf8Bytes("burn-1"));
    const amount = ethers.parseEther("2");
    const network_ = await ethers.provider.getNetwork();
    const messageHash = ethers.solidityPackedKeccak256(
      ["address", "uint256", "address", "uint256", "bytes32"],
      [await noctisLock.getAddress(), network_.chainId, other.address, amount, redemptionId]
    );
    const signature = await relayerWallet.signMessage(ethers.getBytes(messageHash));

    const before = await ethers.provider.getBalance(other.address);
    await noctisLock.unlock(other.address, amount, redemptionId, signature);
    const after = await ethers.provider.getBalance(other.address);

    expect(after - before).to.equal(amount);
    expect(await noctisLock.processedRedemptions(redemptionId)).to.equal(true);
  });

  it("rejects a redemption replayed twice", async () => {
    const { depositor, other, relayerWallet, noctisLock } = await deployFixture();
    const midnightRecipient = ethers.keccak256(ethers.toUtf8Bytes("recipient"));
    await noctisLock.connect(depositor).deposit(midnightRecipient, { value: ethers.parseEther("1") });

    const redemptionId = ethers.keccak256(ethers.toUtf8Bytes("burn-replay"));
    const amount = ethers.parseEther("1");
    const network_ = await ethers.provider.getNetwork();
    const messageHash = ethers.solidityPackedKeccak256(
      ["address", "uint256", "address", "uint256", "bytes32"],
      [await noctisLock.getAddress(), network_.chainId, other.address, amount, redemptionId]
    );
    const signature = await relayerWallet.signMessage(ethers.getBytes(messageHash));

    await noctisLock.unlock(other.address, amount, redemptionId, signature);
    await expect(
      noctisLock.unlock(other.address, amount, redemptionId, signature)
    ).to.be.revertedWith("redemption already processed");
  });

  it("rejects an unlock signed by a non-relayer key", async () => {
    const { depositor, other, noctisLock } = await deployFixture();
    const midnightRecipient = ethers.keccak256(ethers.toUtf8Bytes("recipient"));
    await noctisLock.connect(depositor).deposit(midnightRecipient, { value: ethers.parseEther("1") });

    const redemptionId = ethers.keccak256(ethers.toUtf8Bytes("burn-bad-signer"));
    const amount = ethers.parseEther("1");
    const network_ = await ethers.provider.getNetwork();
    const messageHash = ethers.solidityPackedKeccak256(
      ["address", "uint256", "address", "uint256", "bytes32"],
      [await noctisLock.getAddress(), network_.chainId, other.address, amount, redemptionId]
    );
    const impostor = ethers.Wallet.createRandom();
    const signature = await impostor.signMessage(ethers.getBytes(messageHash));

    await expect(
      noctisLock.unlock(other.address, amount, redemptionId, signature)
    ).to.be.revertedWith("invalid relayer signature");
  });
});
