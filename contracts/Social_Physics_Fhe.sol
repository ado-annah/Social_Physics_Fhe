pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract SocialPhysicsFHE is SepoliaConfig {
    using FHE for *;

    error NotOwner();
    error NotProvider();
    error Paused();
    error CooldownActive();
    error InvalidBatchState();
    error InvalidParameter();
    error ReplayAttempt();
    error StateMismatch();
    error ProofVerificationFailed();

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }

    struct SimulationParameters {
        euint32 interactionStrength; // Encrypted: Strength of social interaction
        euint32 conformityFactor;   // Encrypted: Tendency to conform to group
        euint32 innovationFactor;   // Encrypted: Tendency to innovate/deviate
        euint32 resourceLevel;      // Encrypted: Individual resource level
    }

    struct AgentState {
        euint32 opinion;          // Encrypted: Agent's opinion on a scale
        euint32 influence;        // Encrypted: Agent's influence score
        euint32 satisfaction;     // Encrypted: Agent's satisfaction level
    }

    struct AggregatedResults {
        euint32 averageOpinion;
        euint32 polarizationMetric;
        euint32 averageSatisfaction;
    }

    mapping(address => bool) public isProvider;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;
    mapping(uint256 => SimulationParameters) public batchParameters;
    mapping(uint256 => AgentState[]) public batchAgentStates;
    mapping(uint256 => AggregatedResults) public batchResults;
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    address public owner;
    bool public paused;
    uint256 public cooldownSeconds;
    uint256 public currentBatchId;
    uint256 public agentCountInCurrentBatch;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event ContractPaused(address indexed account);
    event ContractUnpaused(address indexed account);
    event CooldownSet(uint256 oldCooldownSeconds, uint256 newCooldownSeconds);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId, uint256 agentCount);
    event AgentStateSubmitted(address indexed provider, uint256 indexed batchId, uint256 agentIndex);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, uint256 averageOpinion, uint256 polarizationMetric, uint256 averageSatisfaction);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    constructor() {
        owner = msg.sender;
        isProvider[owner] = true;
        cooldownSeconds = 30; // Default cooldown
    }

    function transferOwnership(address newOwner) external onlyOwner {
        address previousOwner = owner;
        owner = newOwner;
        emit OwnershipTransferred(previousOwner, newOwner);
    }

    function addProvider(address provider) external onlyOwner {
        if (!isProvider[provider]) {
            isProvider[provider] = true;
            emit ProviderAdded(provider);
        }
    }

    function removeProvider(address provider) external onlyOwner {
        if (isProvider[provider]) {
            isProvider[provider] = false;
            emit ProviderRemoved(provider);
        }
    }

    function setPause(bool _paused) external onlyOwner {
        if (paused != _paused) {
            paused = _paused;
            if (_paused) {
                emit ContractPaused(msg.sender);
            } else {
                emit ContractUnpaused(msg.sender);
            }
        }
    }

    function setCooldown(uint256 _cooldownSeconds) external onlyOwner {
        if (_cooldownSeconds == 0) revert InvalidParameter();
        uint256 oldCooldown = cooldownSeconds;
        cooldownSeconds = _cooldownSeconds;
        emit CooldownSet(oldCooldown, _cooldownSeconds);
    }

    function openBatch(
        euint32 interactionStrength,
        euint32 conformityFactor,
        euint32 innovationFactor,
        euint32 resourceLevel
    ) external onlyOwner whenNotPaused {
        if (FHE.isInitialized(interactionStrength) || FHE.isInitialized(conformityFactor) ||
            FHE.isInitialized(innovationFactor) || FHE.isInitialized(resourceLevel)) {
            revert InvalidParameter(); // Parameters must be uninitialized for this setup
        }
        currentBatchId++;
        agentCountInCurrentBatch = 0;

        batchParameters[currentBatchId] = SimulationParameters({
            interactionStrength: interactionStrength,
            conformityFactor: conformityFactor,
            innovationFactor: innovationFactor,
            resourceLevel: resourceLevel
        });

        emit BatchOpened(currentBatchId);
    }

    function closeBatch() external onlyOwner whenNotPaused {
        if (agentCountInCurrentBatch == 0) revert InvalidBatchState(); // Cannot close an empty batch
        // Simulate and aggregate results
        _simulateBatch(currentBatchId);
        emit BatchClosed(currentBatchId, agentCountInCurrentBatch);
        // Reset for next batch, currentBatchId will be incremented on next openBatch
        agentCountInCurrentBatch = 0;
    }

    function submitAgentState(
        euint32 opinion,
        euint32 influence,
        euint32 satisfaction
    ) external onlyProvider whenNotPaused {
        if (block.timestamp < lastSubmissionTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        if (!FHE.isInitialized(batchParameters[currentBatchId].interactionStrength)) {
            revert InvalidBatchState(); // Batch not properly opened or parameters not set
        }

        lastSubmissionTime[msg.sender] = block.timestamp;
        batchAgentStates[currentBatchId].push(AgentState({ opinion: opinion, influence: influence, satisfaction: satisfaction }));
        agentCountInCurrentBatch++;
        emit AgentStateSubmitted(msg.sender, currentBatchId, agentCountInCurrentBatch - 1);
    }

    function requestBatchResultsDecryption(uint256 batchId) external onlyOwner whenNotPaused {
        if (block.timestamp < lastDecryptionRequestTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        if (batchId == 0 || batchId > currentBatchId || batchResults[batchId].averageOpinion == euint32(0)) {
            revert InvalidBatchState(); // Batch not closed or results not computed
        }

        lastDecryptionRequestTime[msg.sender] = block.timestamp;

        AggregatedResults storage results = batchResults[batchId];
        bytes32[] memory cts = new bytes32[](3);
        cts[0] = FHE.toBytes32(results.averageOpinion);
        cts[1] = FHE.toBytes32(results.polarizationMetric);
        cts[2] = FHE.toBytes32(results.averageSatisfaction);

        bytes32 stateHash = _hashCiphertexts(cts);
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);

        decryptionContexts[requestId] = DecryptionContext({ batchId: batchId, stateHash: stateHash, processed: false });
        emit DecryptionRequested(requestId, batchId);
    }

    function myCallback(uint256 requestId, bytes memory cleartexts, bytes memory proof) public {
        if (decryptionContexts[requestId].processed) revert ReplayAttempt();
        if (cleartexts.length != 3 * 32) revert InvalidParameter(); // Expecting 3 uint256 values

        // Rebuild ciphertexts from current storage for state verification
        AggregatedResults storage results = batchResults[decryptionContexts[requestId].batchId];
        bytes32[] memory currentCts = new bytes32[](3);
        currentCts[0] = FHE.toBytes32(results.averageOpinion);
        currentCts[1] = FHE.toBytes32(results.polarizationMetric);
        currentCts[2] = FHE.toBytes32(results.averageSatisfaction);

        bytes32 currentStateHash = _hashCiphertexts(currentCts);
        if (currentStateHash != decryptionContexts[requestId].stateHash) {
            revert StateMismatch();
        }

        if (!FHE.checkSignatures(requestId, cleartexts, proof)) {
            revert ProofVerificationFailed();
        }

        // Decode cleartexts
        uint256 resAverageOpinion = abi.decode(cleartexts[:32], (uint256));
        uint256 resPolarizationMetric = abi.decode(cleartexts[32:64], (uint256));
        uint256 resAverageSatisfaction = abi.decode(cleartexts[64:96], (uint256));

        decryptionContexts[requestId].processed = true;
        emit DecryptionCompleted(requestId, decryptionContexts[requestId].batchId, resAverageOpinion, resPolarizationMetric, resAverageSatisfaction);
    }

    function _simulateBatch(uint256 batchId) internal {
        SimulationParameters storage params = batchParameters[batchId];
        AgentState[] storage agents = batchAgentStates[batchId];

        if (agents.length == 0) return; // Should be caught by closeBatch

        // Initialize encrypted accumulators
        euint32 totalOpinion = FHE.asEuint32(0);
        euint32 totalSatisfaction = FHE.asEuint32(0);
        euint32 sumOfSquaredOpinions = FHE.asEuint32(0); // For polarization (variance proxy)
        euint32 count = FHE.asEuint32(agents.length);

        for (uint256 i = 0; i < agents.length; i++) {
            AgentState storage agent = agents[i];
            totalOpinion = FHE.add(totalOpinion, agent.opinion);
            totalSatisfaction = FHE.add(totalSatisfaction, agent.satisfaction);
            sumOfSquaredOpinions = FHE.add(sumOfSquaredOpinions, FHE.mul(agent.opinion, agent.opinion));
        }

        euint32 averageOpinion = FHE.div(totalOpinion, count);
        euint32 averageSatisfaction = FHE.div(totalSatisfaction, count);

        // Polarization Metric: E[(X - E[X])^2] = E[X^2] - (E[X])^2
        euint32 eXsquared = FHE.div(sumOfSquaredOpinions, count);
        euint32 eXsquared_avg = FHE.mul(averageOpinion, averageOpinion);
        euint32 polarizationMetric = FHE.sub(eXsquared, eXsquared_avg);

        batchResults[batchId] = AggregatedResults({
            averageOpinion: averageOpinion,
            polarizationMetric: polarizationMetric,
            averageSatisfaction: averageSatisfaction
        });
    }

    function _hashCiphertexts(bytes32[] memory cts) internal pure returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }
}