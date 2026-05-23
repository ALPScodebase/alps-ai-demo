// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./IAggregator.sol";
import "./IOracleVerifier.sol";

contract RoyaltyManager {
    address public owner; // Owner address.
    address[] public holders; // Array of data holders' addresses.
    IOracleVerifier public verifier; // Link to the OracleVerifier contract.
    IAggregator public aggregator; // Link to the Aggregator contract.
    mapping(address => uint256) public balances; // Stores account balances for each holder.
    event RewardsDistributed(uint256 indexed jobId); // Emitted when rewards are distributed.
    uint256 public norm_factor = 1e18; // Normalization factor for score distribution.

    modifier onlyOwner() {
        require(msg.sender == owner, "Only Owner allowed");
        _;
    }

    modifier onlyAggregator() {
        require(msg.sender == address(aggregator), "Only Aggregator allowed");
        _;
    }

    constructor(address[] memory _holders, address _verifierAddress) {
        require(_holders.length > 0, "No holders provided");
        holders = _holders;
        verifier = IOracleVerifier(_verifierAddress);
        owner = msg.sender;
    }

    // Set the Aggregator contract address (can only be set by the owner).  
    function setAggregator(address _aggregatorAddress) external onlyOwner {
        require(_aggregatorAddress != address(0), "Invalid address");
        // Connect the interface to the specified address.
        aggregator = IAggregator(_aggregatorAddress);
    }

    // Distributes rewards to data holders based on the job result.
    function rewardHolders(uint256 _jobId) external payable onlyAggregator {
        require(msg.value > 0, "No funds available for distribution");
        // Fetch job result to determine holders' shares.
        (int128[] memory data, , ) = verifier.getResult(_jobId);
        // Distribute rewards proportionally based on data scores.
        uint128 u;
        uint32 ownerId;
        uint96 score;
        for (uint i = 0; i < data.length; i++) {
            // Decode result data based on the 
            // [ownerId (32 bits) | score (96 bits)] encoding scheme.
            u = uint128(data[i]);
            ownerId = uint32(u >> 96); // first 32 bits
            score = uint96(u & ((1 << 96) - 1)); // last 96 bits
            uint256 payment = (msg.value * uint256(score)) / norm_factor;
            balances[holders[ownerId]] += payment;
        }
        emit RewardsDistributed(_jobId); // Notify reward distribution.
    }

    // Allows holders to withdraw their accumulated rewards.
    function withdraw() external {
        uint256 amount = balances[msg.sender];
        require(amount > 0, "Nothing to withdraw");
        (bool success, ) = payable(msg.sender).call{value: amount}("");
        require(success, "Transfer failed");
        balances[msg.sender] = 0;
    }

    // Allows the owner to register new data holders to the contract.
    function registerHolder(address _holder) external onlyOwner {
        require(_holder != address(0), "Invalid address");
        holders.push(_holder);
    }

    // Returns the total number of registered data holders.
    function getNumHolders() external view returns (uint256) {
        return holders.length;
    }

}