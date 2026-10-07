// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title Vault
/// @notice Shared liquidity pool. Liquidity providers hold shares; the balance is split into
///         free, locked (collateral for open policies) and claimable (settled payouts).
/// @dev Invariant: balance == free + locked + claimable, with free defined as the remainder.
///      Liquidity providers can only withdraw from the free part. Premiums arrive as plain ETH
///      transfers and raise the value of every share.
contract Vault is AccessControl, ReentrancyGuard {
    /// @notice Role held by the settlement engine.
    bytes32 public constant ENGINE_ROLE = keccak256("ENGINE_ROLE");
    /// @notice Role held by the policy book.
    bytes32 public constant BOOK_ROLE = keccak256("BOOK_ROLE");

    /// @notice Shares permanently minted to a dead address on the first deposit (inflation guard).
    uint256 public constant DEAD_SHARES = 1000;
    /// @notice Holder of the dead shares.
    address public constant DEAD_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    /// @notice Total share supply.
    uint256 public totalShares;
    /// @notice Shares held per account.
    mapping(address => uint256) public sharesOf;
    /// @notice ETH reserved as collateral for open policies.
    uint256 public locked;
    /// @notice ETH owed to policyholders whose policies settled as paying.
    uint256 public claimable;

    /// @notice A liquidity provider added liquidity.
    event Deposit(address indexed lp, uint256 assets, uint256 shares);
    /// @notice A liquidity provider withdrew liquidity.
    event Withdraw(address indexed lp, uint256 assets, uint256 shares);

    /// @notice The first deposit must exceed the dead-share amount.
    error DepositTooSmall(uint256 assets, uint256 minimum);
    /// @notice The deposit would mint zero shares.
    error ZeroShares();
    /// @notice The requested withdrawal exceeds what the account may take now.
    error WithdrawExceedsMax(uint256 requested, uint256 maximum);
    /// @notice There is not enough free liquidity.
    error InsufficientFree(uint256 requested, uint256 free);
    /// @notice An accounting bucket does not hold the requested amount.
    error InsufficientBucket(uint256 requested, uint256 available);
    /// @notice An ETH transfer failed.
    error TransferFailed();
    /// @notice The amount must be non-zero.
    error ZeroAmount();

    /// @param admin Account receiving the admin role.
    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /// @notice Accept ETH (premiums, forfeited bonds, donations). Raises the value of every share.
    receive() external payable {}

    /// @notice ETH held by the vault that backs LP shares: balance minus settled payouts.
    /// @return Total assets attributable to liquidity providers.
    function totalAssets() public view returns (uint256) {
        return address(this).balance - claimable;
    }

    /// @notice ETH that is neither locked as collateral nor owed as a payout.
    /// @return Free liquidity.
    function freeLiquidity() public view returns (uint256) {
        return address(this).balance - locked - claimable;
    }

    /// @notice Value of `shares` in ETH, rounded down.
    /// @param shares Share amount.
    /// @return Assets those shares are worth.
    function convertToAssets(uint256 shares) public view returns (uint256) {
        if (totalShares == 0) return 0;
        return Math.mulDiv(shares, totalAssets(), totalShares);
    }

    /// @notice Most ETH `account` can withdraw right now: the lesser of its share value and the
    ///         free liquidity.
    /// @param account The liquidity provider.
    /// @return The withdrawable amount.
    function maxWithdraw(address account) public view returns (uint256) {
        return Math.min(convertToAssets(sharesOf[account]), freeLiquidity());
    }

    /// @notice Deposit ETH and receive pro-rata shares.
    /// @return shares Shares minted to the caller.
    function deposit() external payable nonReentrant returns (uint256 shares) {
        if (msg.value == 0) revert ZeroAmount();
        if (totalShares == 0) {
            if (msg.value <= DEAD_SHARES) revert DepositTooSmall(msg.value, DEAD_SHARES + 1);
            shares = msg.value - DEAD_SHARES;
            totalShares = msg.value;
            sharesOf[DEAD_ADDRESS] = DEAD_SHARES;
        } else {
            uint256 assetsBefore = totalAssets() - msg.value;
            shares = Math.mulDiv(msg.value, totalShares, assetsBefore);
            if (shares == 0) revert ZeroShares();
            totalShares += shares;
        }
        sharesOf[msg.sender] += shares;
        emit Deposit(msg.sender, msg.value, shares);
    }

    /// @notice Withdraw `assets` ETH by burning the matching shares (rounded up).
    /// @param assets Amount to withdraw; at most `maxWithdraw(msg.sender)`.
    /// @return shares Shares burned.
    function withdraw(uint256 assets) external nonReentrant returns (uint256 shares) {
        if (assets == 0) revert ZeroAmount();
        uint256 max = maxWithdraw(msg.sender);
        if (assets > max) revert WithdrawExceedsMax(assets, max);
        shares = Math.mulDiv(assets, totalShares, totalAssets(), Math.Rounding.Ceil);
        sharesOf[msg.sender] -= shares;
        totalShares -= shares;
        emit Withdraw(msg.sender, assets, shares);
        _send(msg.sender, assets);
    }

    /// @notice Reserve free liquidity as collateral for a new policy.
    /// @param amount ETH to lock.
    function lock(uint256 amount) external onlyRole(BOOK_ROLE) {
        uint256 free = freeLiquidity();
        if (amount > free) revert InsufficientFree(amount, free);
        locked += amount;
    }

    /// @notice Release locked collateral back to free liquidity (policy settled as not paying).
    /// @param amount ETH to unlock.
    function unlock(uint256 amount) external onlyRole(ENGINE_ROLE) {
        _takeLocked(amount);
    }

    /// @notice Turn locked collateral into a claimable payout (policy settled as paying).
    /// @param amount ETH to move.
    function moveLockedToClaimable(uint256 amount) external onlyRole(ENGINE_ROLE) {
        _takeLocked(amount);
        claimable += amount;
    }

    /// @notice Pay a settled claim out of the claimable balance.
    /// @param to Recipient.
    /// @param amount ETH to pay.
    function payClaim(address to, uint256 amount) external onlyRole(BOOK_ROLE) nonReentrant {
        if (amount > claimable) revert InsufficientBucket(amount, claimable);
        claimable -= amount;
        _send(to, amount);
    }

    function _takeLocked(uint256 amount) private {
        if (amount > locked) revert InsufficientBucket(amount, locked);
        locked -= amount;
    }

    function _send(address to, uint256 amount) private {
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
