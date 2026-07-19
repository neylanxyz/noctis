// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title NoctisLock
/// @notice Ethereum-side escrow for the Noctis privacy bridge. ETH deposited here is
/// mirrored as a shielded token on Midnight by an off-chain relayer; ETH is only
/// released back on a signature from the relayer attesting to a burn on Midnight.
contract NoctisLock is Ownable, ReentrancyGuard {
    using ECDSA for bytes32;

    /// @notice Address whose signature authorizes unlocks (the relayer service key).
    /// MVP trust assumption: a single relayer key. See README for the multisig upgrade path.
    address public relayer;

    uint256 public depositNonce;

    mapping(bytes32 => bool) public processedRedemptions;

    event Locked(
        bytes32 indexed depositId,
        address indexed depositor,
        uint256 amount,
        bytes32 midnightRecipient,
        uint256 nonce
    );

    event Unlocked(
        bytes32 indexed redemptionId,
        address indexed to,
        uint256 amount
    );

    event RelayerUpdated(address indexed previousRelayer, address indexed newRelayer);

    constructor(address initialRelayer) Ownable(msg.sender) {
        require(initialRelayer != address(0), "relayer cannot be zero address");
        relayer = initialRelayer;
        emit RelayerUpdated(address(0), initialRelayer);
    }

    /// @notice Lock ETH to be minted as a shielded token on Midnight.
    /// @param midnightRecipient Commitment identifying the recipient's Midnight shielded
    /// address (opaque bytes32 from the Midnight side, e.g. a hash of the public key).
    function deposit(bytes32 midnightRecipient) external payable returns (bytes32 depositId) {
        require(msg.value > 0, "deposit amount must be > 0");
        require(midnightRecipient != bytes32(0), "midnightRecipient required");

        uint256 nonce = depositNonce++;
        depositId = keccak256(
            abi.encodePacked(address(this), block.chainid, msg.sender, msg.value, midnightRecipient, nonce)
        );

        emit Locked(depositId, msg.sender, msg.value, midnightRecipient, nonce);
    }

    /// @notice Release ETH previously locked, authorized by a relayer signature attesting
    /// that the matching shielded token was burned on Midnight.
    /// @param to Recipient of the released ETH.
    /// @param amount Amount of ETH to release.
    /// @param redemptionId Unique id of the Midnight-side burn (prevents replay).
    /// @param signature Relayer signature over (this, chainid, to, amount, redemptionId).
    function unlock(
        address payable to,
        uint256 amount,
        bytes32 redemptionId,
        bytes calldata signature
    ) external nonReentrant {
        require(!processedRedemptions[redemptionId], "redemption already processed");

        bytes32 messageHash = keccak256(
            abi.encodePacked(address(this), block.chainid, to, amount, redemptionId)
        );
        address signer = MessageHashUtils.toEthSignedMessageHash(messageHash).recover(signature);
        require(signer == relayer, "invalid relayer signature");

        processedRedemptions[redemptionId] = true;

        (bool success, ) = to.call{value: amount}("");
        require(success, "ETH transfer failed");

        emit Unlocked(redemptionId, to, amount);
    }

    /// @notice Rotate the relayer key. Owner-only; in production this should be replaced
    /// by a timelock or multisig-gated upgrade path.
    function setRelayer(address newRelayer) external onlyOwner {
        require(newRelayer != address(0), "relayer cannot be zero address");
        emit RelayerUpdated(relayer, newRelayer);
        relayer = newRelayer;
    }

    receive() external payable {
        revert("send via deposit()");
    }
}
