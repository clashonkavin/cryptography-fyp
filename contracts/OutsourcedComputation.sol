// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./lib/SchnorrVerifier.sol";
import "./lib/BytesUtils.sol";

/**
 * @title OutsourcedComputation
 * @notice Blockchain-based outsourced computation with pairing-free PKEET-LE inspired crypto.
 *         Contractors submit encrypted results + Schnorr proofs; contract verifies,
 *         groups by equality tag (C4), selects majority, and rewards honest workers.
 *
 * Crypto scheme (secp256k1, pairing-free):
 *   - Encryption: C1 = g^r, C2 = M * pk_d^r  (ElGamal)
 *   - Equality tag: C4 = g^m * h^H1(m)
 *   - Proof: Schnorr PoK of r  =>  (R, z) s.t. g^z == R * C1^e
 */
contract OutsourcedComputation {

    // ─────────────────────────────────────────────────────────────────────────
    // Data structures
    // ─────────────────────────────────────────────────────────────────────────

    struct Task {
        uint256 id;
        address client;
        string  description;
        uint256 reward;
        bool    finalized;
        bytes   winningC1;
        bytes   winningC2;
        bytes   winningC4;
        uint256 submissionCount;
    }

    struct Submission {
        address contractor;
        bytes   C1;          // g^r  (compressed point, 33 bytes)
        bytes   C2;          // M * pk_d^r  (compressed point, 33 bytes)
        bytes   C4;          // equality tag (compressed point, 33 bytes)
        bytes   R;           // Schnorr nonce commitment (compressed point, 33 bytes)
        bytes   zBytes;      // Schnorr response scalar (32 bytes)
        bytes   pkE;         // contractor's public key (compressed, 33 bytes)
        bool    verified;
        bool    rewarded;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Storage
    // ─────────────────────────────────────────────────────────────────────────

    uint256 public taskCount;
    mapping(uint256 => Task) public tasks;
    // taskId => array of submissions
    mapping(uint256 => Submission[]) public submissions;

    // ─────────────────────────────────────────────────────────────────────────
    // Events
    // ─────────────────────────────────────────────────────────────────────────

    event TaskCreated(uint256 indexed taskId, address indexed client, string description, uint256 reward);
    event ResultSubmitted(uint256 indexed taskId, address indexed contractor, uint256 submissionIndex, bool proofValid);
    event TaskFinalized(uint256 indexed taskId, bytes winningC4, uint256 majorityCount, uint256 totalSubmissions);
    event ContractorRewarded(uint256 indexed taskId, address indexed contractor, uint256 amount);
    event ContractorRejected(uint256 indexed taskId, address indexed contractor, string reason);

    // ─────────────────────────────────────────────────────────────────────────
    // 1. Create Task
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Client posts a computation task and deposits the reward.
     * @param description  Human-readable description (e.g. "Compute square of 5")
     * @param reward       Reward amount (must match msg.value)
     */
    function createTask(string memory description, uint256 reward) public payable returns (uint256) {
        require(msg.value == reward, "msg.value must equal reward");
        require(reward > 0, "Reward must be > 0");

        uint256 taskId = ++taskCount;
        tasks[taskId] = Task({
            id: taskId,
            client: msg.sender,
            description: description,
            reward: reward,
            finalized: false,
            winningC1: "",
            winningC2: "",
            winningC4: "",
            submissionCount: 0
        });

        emit TaskCreated(taskId, msg.sender, description, reward);
        return taskId;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 2. Submit Result
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Contractor submits encrypted result + Schnorr proof.
     *         On-chain Schnorr verification uses ecrecover trick for efficiency.
     *
     * @param taskId  Target task
     * @param C1      g^r  (33-byte compressed point)
     * @param C2      M * pk_d^r  (33-byte compressed point)
     * @param C4      equality tag (33-byte compressed point)
     * @param R       Schnorr nonce commitment g^k  (33-byte compressed point)
     * @param zBytes  Schnorr response z = k + e*r  (32 bytes, big-endian)
     * @param pkE     Contractor public key  (33-byte compressed point)
     */
    function submitResult(
        uint256 taskId,
        bytes memory C1,
        bytes memory C2,
        bytes memory C4,
        bytes memory R,
        bytes memory zBytes,
        bytes memory pkE
    ) public {
        Task storage task = tasks[taskId];
        require(task.id != 0,       "Task does not exist");
        require(!task.finalized,    "Task already finalized");
        require(C1.length == 33,    "C1 must be 33 bytes");
        require(C2.length == 33,    "C2 must be 33 bytes");
        require(C4.length == 33,    "C4 must be 33 bytes");
        require(R.length  == 33,    "R must be 33 bytes");
        require(zBytes.length == 32,"z must be 32 bytes");
        require(pkE.length == 33,   "pkE must be 33 bytes");

        // Verify Schnorr proof: g^z == R * C1^e
        bool valid = SchnorrVerifier.verifySchnorr(C1, C2, C4, R, zBytes, pkE);

        uint256 idx = submissions[taskId].length;
        submissions[taskId].push(Submission({
            contractor: msg.sender,
            C1: C1,
            C2: C2,
            C4: C4,
            R: R,
            zBytes: zBytes,
            pkE: pkE,
            verified: valid,
            rewarded: false
        }));
        task.submissionCount++;

        if (!valid) {
            emit ContractorRejected(taskId, msg.sender, "Invalid Schnorr proof");
        }
        emit ResultSubmitted(taskId, msg.sender, idx, valid);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 3. Finalize Task
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Groups verified submissions by C4 (equality tag), picks the majority,
     *         stores the winning ciphertext, and pays out winning contractors.
     * @param taskId  Target task
     */
    function finalizeTask(uint256 taskId) public {
        Task storage task = tasks[taskId];
        require(task.id != 0,    "Task does not exist");
        require(!task.finalized, "Already finalized");
        require(msg.sender == task.client, "Only client can finalize");

        Submission[] storage subs = submissions[taskId];
        uint256 n = subs.length;
        require(n > 0, "No submissions");

        // ── Find majority C4 ──────────────────────────────────────────────
        // O(n^2) — acceptable for small n (5–20 contractors)
        bytes memory winC4;
        uint256 winCount = 0;
        uint256 winIdx   = type(uint256).max;

        for (uint256 i = 0; i < n; i++) {
            if (!subs[i].verified) continue;
            uint256 cnt = 0;
            for (uint256 j = 0; j < n; j++) {
                if (subs[j].verified && BytesUtils.bytesEqual(subs[i].C4, subs[j].C4)) {
                    cnt++;
                }
            }
            if (cnt > winCount) {
                winCount = cnt;
                winC4    = subs[i].C4;
                winIdx   = i;
            }
        }

        require(winCount > 0, "No valid submissions found");

        // ── Store winning ciphertext ──────────────────────────────────────
        task.winningC1  = subs[winIdx].C1;
        task.winningC2  = subs[winIdx].C2;
        task.winningC4  = winC4;
        task.finalized  = true;

        // ── Reward winning contractors ────────────────────────────────────
        uint256 perContractor = task.reward / winCount;

        for (uint256 i = 0; i < n; i++) {
            Submission storage s = subs[i];
            if (s.verified && BytesUtils.bytesEqual(s.C4, winC4) && !s.rewarded) {
                s.rewarded = true;
                (bool sent, ) = payable(s.contractor).call{value: perContractor}("");
                require(sent, "ETH transfer failed");
                emit ContractorRewarded(taskId, s.contractor, perContractor);
            } else if (s.verified && !BytesUtils.bytesEqual(s.C4, winC4)) {
                emit ContractorRejected(taskId, s.contractor, "Minority result");
            }
        }

        emit TaskFinalized(taskId, winC4, winCount, n);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 4. View Result
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Returns the winning ciphertext (C1, C2) so the client can decrypt.
     */
    function getWinningCiphertext(uint256 taskId)
        public view
        returns (bytes memory C1, bytes memory C2, bytes memory C4)
    {
        Task storage task = tasks[taskId];
        require(task.finalized, "Task not yet finalized");
        return (task.winningC1, task.winningC2, task.winningC4);
    }

    /**
     * @notice Returns all submissions for a task (for off-chain inspection).
     */
    function getSubmissionCount(uint256 taskId) public view returns (uint256) {
        return submissions[taskId].length;
    }

    function getSubmission(uint256 taskId, uint256 idx)
        public view
        returns (
            address contractor,
            bytes memory C1,
            bytes memory C2,
            bytes memory C4,
            bool verified,
            bool rewarded
        )
    {
        Submission storage s = submissions[taskId][idx];
        return (s.contractor, s.C1, s.C2, s.C4, s.verified, s.rewarded);
    }
}
