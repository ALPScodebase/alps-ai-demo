// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IAggregator {
    enum FilterType {
        TOP_VALUES,
        TOP_HOLDERS
    }
    function requestAttribution(string calldata _ipfsCid) external payable returns (uint256);
    function approveJob(uint256 _requestId) external returns (uint256);
    function transmit(
        bytes32 configDigest,
        uint64 seqNr,
        bytes calldata report,
        bytes32[] calldata rs, 
        bytes32[] calldata ss, 
        bytes32 rawVs
    ) external;
    function distributeRewards(address payable _oracle, uint256 _jobId) external;
    function getResult(uint256 _jobId) external view returns (int128[] memory, address, uint256);
    function getResultSubmitter(uint256 _jobId) external view returns (address);
    function isCompleted(uint256 _jobId) external view returns (bool);
    function setFilterPolicy(FilterType _filterType, uint256 _threshold) external;
    function getFilterPolicy() external view returns (FilterType, uint256);
}
