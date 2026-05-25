// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./IAggregator.sol";
import "./IOracleVerifier.sol";

contract OracleVerifier is IOracleVerifier {
    address public owner; // Owner address.
    IAggregator public aggregator; // Reference to the Aggregator contract.

    // Struct to store the result of a job.
    struct Result {
        int128[] flatMatrix;
        address  submitter;
        uint256  timestamp;
        bool     saved;
    }

    // Mappings to store job results and track used sequence numbers for replay protection.
    mapping(uint256 => Result) public results;
    mapping(uint64  => bool)   public usedSeqNr; // To avoid replay attacks

    // Mapping to track authorized oracles.
    mapping(address => bool) public isOracle;
    uint8 public f; // Maximum number of faulty nodes.
    bytes32 public expectedConfigDigest; 

    // Emitted when a job is completed and its result is stored.
    event JobCompleted(uint256 indexed jobId, address indexed submitter, uint256 vectorLength, uint256 timestamp);

    modifier onlyOwner() {
        require(msg.sender == owner, "Only Owner allowed");
        _;
    }

    modifier onlyAggregator() {
        require(msg.sender == address(aggregator), "Only Aggregator allowed");
        _;
    }

    function setAggregator(address _aggregatorAddress) external onlyOwner {
        require(_aggregatorAddress != address(0), "Invalid address");
        // Connect the interface to the specified address.
        aggregator = IAggregator(_aggregatorAddress);
    }

    // Constructor
    constructor(address[] memory _oracles, uint8 _f, bytes32 _configDigest) {
        require(_oracles.length >= 3 * _f + 1, "Network too small for the given f");
        for (uint i = 0; i < _oracles.length; i++) {
            isOracle[_oracles[i]] = true;
        }
        f = _f;
        expectedConfigDigest = _configDigest;
        owner = msg.sender;
    }

    // =====================================================================
    // CUSTOM HASH FUNCTION (Perfect mirror of the Go keyring logic)
    // =====================================================================
    function _computeCustomHash (
        bytes32 configDigest,
        uint64 seqNr,
        bytes calldata report
    ) internal pure returns (bytes32) {
        // Use of encodePacked to concat the bytes without padding
        return keccak256(abi.encodePacked(configDigest, seqNr, report));
    }

    // =========================================================================
    // TRANSMIT FUNCTION (Standard OCR signature verification)
    // =========================================================================    
    function transmit(
        bytes32 configDigest,
        uint64 seqNr,
        bytes calldata report,
        bytes32[] calldata rs, 
        bytes32[] calldata ss, 
        bytes32 rawVs // A single bytes32 parameter containing up to 32 packed 'v' values
    ) external override onlyAggregator {
        // We use tx.origin to identify the original sender of the transaction.
        address transmitter = tx.origin;

        // Basic checks and Anti-Replay protection
        require(configDigest == expectedConfigDigest, "Invalid ConfigDigest");
        require(!usedSeqNr[seqNr], "Sequence Number already used (Replay Attack)");
        // Check if the transmitter is an authorized oracle.
        require(isOracle[transmitter], "Unauthorized transmitter");

        // Mark the sequence number as used
        usedSeqNr[seqNr] = true;

        // 1. Calculate the hash using raw byte concatenation
        bytes32 signedHash = _computeCustomHash(configDigest, seqNr, report);

        uint256 validSignatures = 0;

        // Create an in-memory array to track signers and prevent duplicates
        address[] memory seenSigners = new address[](rs.length);

        for (uint i = 0; i < rs.length; i++) {
            uint8 v = uint8(rawVs[i]);
            
            // 2. Perform ecrecover, retrieving the address of the oracles
            address signer = ecrecover(signedHash, v, rs[i], ss[i]);
            // check oracle signature
            require(isOracle[signer], "Unauthorized signature");

            // Check for duplicate signatures
            for (uint j = 0; j < i; j++) {
                require(seenSigners[j] != signer, "Duplicate signature found");
            }
            seenSigners[i] = signer;
            validSignatures++;
        }

        // Check the required signatures
        require(validSignatures >= f + 1, "BFT Quorum not reached");

        // Decoding and Storage
        (uint256 jobId, int128[] memory _flatMatrix) = abi.decode(report, (uint256, int128[]));
        // Revert if the job is already saved by another oracle
        require(!results[jobId].saved, "Job already completed");

        results[jobId] = Result({
            flatMatrix:     _flatMatrix,
            submitter:      transmitter,
            timestamp:      block.timestamp,
            saved:          true
        });

        emit JobCompleted(jobId, transmitter, _flatMatrix.length, block.timestamp);

        // Call the Aggregator function that unlock the funds and triggers rewards.
        aggregator.distributeRewards(payable(transmitter), jobId);
    }

    // Returns the result of a completed job.
    function getResult(uint256 _jobId) external override view returns (int128[] memory, address, uint256) {
        require(results[_jobId].saved, "Result not found");
        return (results[_jobId].flatMatrix, results[_jobId].submitter, results[_jobId].timestamp);
    }

    // Returns the submitter of a completed job.
    function getResultSubmitter(uint256 _jobId) external override view returns (address) {
        require(results[_jobId].saved, "Result not found");
        return results[_jobId].submitter;
    }

    // Checks if the job is completed.
    function isCompleted(uint256 _jobId) external override view returns (bool) {
        return results[_jobId].saved;
    }

}
