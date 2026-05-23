// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IRoyaltyManager {
    function setAggregator(address _aggregatorAddress) external;
    function rewardHolders(uint256 _jobId) external payable;
    function withdraw() external;
    function registerHolder(address _holder) external;
    function getNumHolders() external view returns (uint256);
}
