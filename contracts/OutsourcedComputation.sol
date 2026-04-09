// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./lib/DLEQVerifier.sol";
import "./lib/BytesUtils.sol";

/**
 * @title OutsourcedComputation
 * @notice Blockchain-based outsourced computation with pairing-free PKEET-LE.
 *
 * ─── Cryptographic scheme ────────────────────────────────────────────────────
 *
 *   Each contractor computes result D and submits ciphertext CT:
 *
 *     m   = H(D)                     — deterministic digest of the result
 *     r   ∈ Z_p                      — fresh random scalar
 *     C1  = g^r                      — ElGamal randomness commitment
 *     C2  = ECIES(pk_d, D)           — hybrid encryption of D for the client
 *     C3  = H2(g^m)                  — equality tag: same D ⟹ same C3
 *     C4  = C3^r                     — binding tag commitment
 *     π   = (A1, A4, zr)             — DLEQ proof:  log_g(C1) = log_{C3}(C4)
 *
 *   Equality test (on-chain, no pairing):
 *     EqTest(CT_i, CT_j)  ≡  ( C3_i == C3_j )
 *
 *   Majority selection groups verified submissions by C3.
 *   The largest group wins; its members share the reward equally.
 *
 * ─────────────────────────────────────────────────────────────────────────────
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
        // Winning ciphertext stored for client decryption
        bytes   winningC1;   // g^r  of winner
        bytes   winningC2;   // ECIES(pk_d, D) of winner
        bytes   winningC3;   // equality tag of winning group
        uint256 submissionCount;
    }

    /**
     * @dev Full ciphertext + DLEQ proof as submitted by a contractor.
     *
     *  Field       Size    Description
     *  ─────────── ─────── ─────────────────────────────────────────────
     *  C1          64 B    g^r                 (uncompressed secp256k1 point: x||y)
     *  C2          var     ECIES(pk_d, D)       (ephemeral pubkey ‖ IV ‖ ct ‖ tag)
     *  C3          64 B    H2(g^m)             (equality tag base)
     *  C4          64 B    C3^r                (equality tag commitment)
     *  A1          64 B    g^kr                (DLEQ nonce on generator)
     *  A4          64 B    C3^kr               (DLEQ nonce on C3)
     *  zrBytes     32 B    zr = kr + e·r mod N (DLEQ response scalar)
     *  pkE         64 B    contractor pubkey   (binds proof to sender)
     *  verified    bool    true iff DLEQ check passed at submission time
     *  rewarded    bool    true iff reward has been paid to this contractor
     */
    struct Submission {
        address contractor;
        bytes   C1Proof;    // BN254 proof base (for on-chain DLEQ verification)
        bytes   C1Decrypt;  // secp256k1 compressed C1 used for off-chain decryption
        bytes   C2;
        bytes   C3;
        bytes   C4;
        bytes   A1;
        bytes   A4;
        bytes   zrBytes;
        bytes   pkE;
        bool    verified;
        bool    rewarded;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Storage
    // ─────────────────────────────────────────────────────────────────────────

    uint256 public taskCount;

    /// @dev taskId → Task
    mapping(uint256 => Task) public tasks;

    /// @dev taskId → submissions array
    mapping(uint256 => Submission[]) public submissions;

    // ─────────────────────────────────────────────────────────────────────────
    // Events
    // ─────────────────────────────────────────────────────────────────────────

    event TaskCreated(
        uint256 indexed taskId,
        address indexed client,
        string  description,
        uint256 reward
    );

    /// @param proofValid  true iff the submitted DLEQ proof verified on-chain
    event ResultSubmitted(
        uint256 indexed taskId,
        address indexed contractor,
        uint256 submissionIndex,
        bool    proofValid
    );

    /// @param majorityCount  size of the winning C3 group
    event TaskFinalized(
        uint256 indexed taskId,
        bytes   winningC3,
        uint256 majorityCount,
        uint256 totalSubmissions
    );

    event ContractorRewarded(
        uint256 indexed taskId,
        address indexed contractor,
        uint256 amount
    );

    event ContractorRejected(
        uint256 indexed taskId,
        address indexed contractor,
        string  reason
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Client API
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Post a computation task and deposit the reward in ETH.
     *
     * @param description  Human-readable problem statement.
     * @param reward       Amount in wei (must equal msg.value).
     * @return taskId      The newly assigned task identifier.
     */
    function createTask(
        string memory description,
        uint256 reward
    ) public payable returns (uint256 taskId) {
        require(msg.value == reward, "OutsourcedComputation: msg.value != reward");
        require(reward > 0,          "OutsourcedComputation: reward must be > 0");

        taskId = ++taskCount;
        tasks[taskId] = Task({
            id:               taskId,
            client:           msg.sender,
            description:      description,
            reward:           reward,
            finalized:        false,
            winningC1:        "",
            winningC2:        "",
            winningC3:        "",
            submissionCount:  0
        });

        emit TaskCreated(taskId, msg.sender, description, reward);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Contractor API
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Submit an encrypted result and its DLEQ proof.
     *
     *  All point arguments must be 33-byte SEC-compressed secp256k1 points.
     *  zrBytes must be a 32-byte big-endian scalar.
     *
     *  On-chain verification:
     *   1. g^zr  == A1 · C1^e   (DLEQ check 1)
     *   2. C3^zr == A4 · C4^e   (DLEQ check 2)
     *  where  e = sha256(A1 ‖ A4 ‖ C1 ‖ C3 ‖ C4 ‖ pkE) mod N.
     *
     * @param taskId   Target task identifier.
     * @param C1Proof   BN254 proof base g^r      (64 bytes)
     * @param C1Decrypt secp256k1 C1 for decrypt  (33 bytes)
     * @param C2       ECIES(pk_d, D)             (variable length)
     * @param C3       H2(g^m) — equality tag    (33 bytes)
     * @param C4       C3^r                       (33 bytes)
     * @param A1       g^kr   — DLEQ nonce       (33 bytes)
     * @param A4       C3^kr  — DLEQ nonce       (33 bytes)
     * @param zrBytes  zr = kr + e·r mod N       (32 bytes)
     * @param pkE      Contractor's public key    (33 bytes)
     */
    function submitResult(
        uint256 taskId,
        bytes memory C1Proof,
        bytes memory C1Decrypt,
        bytes memory C2,
        bytes memory C3,
        bytes memory C4,
        bytes memory A1,
        bytes memory A4,
        bytes memory zrBytes,
        bytes memory pkE
    ) public {
        Task storage task = tasks[taskId];
        require(task.id != 0,      "OutsourcedComputation: task does not exist");
        require(!task.finalized,   "OutsourcedComputation: task already finalized");

        // Length validation
        require(C1Proof.length == 64, "OutsourcedComputation: C1 proof must be 64 bytes");
        require(C1Decrypt.length == 33, "OutsourcedComputation: C1 decrypt must be 33 bytes");
        require(C2.length      >   0, "OutsourcedComputation: C2 cannot be empty");
        require(C3.length      == 64, "OutsourcedComputation: C3 must be 64 bytes");
        require(C4.length      == 64, "OutsourcedComputation: C4 must be 64 bytes");
        require(A1.length      == 64, "OutsourcedComputation: A1 must be 64 bytes");
        require(A4.length      == 64, "OutsourcedComputation: A4 must be 64 bytes");
        require(zrBytes.length == 32, "OutsourcedComputation: zr must be 32 bytes");
        require(pkE.length     == 64, "OutsourcedComputation: pkE must be 64 bytes");

        // ── DLEQ verification ────────────────────────────────────────────────
        bool valid = DLEQVerifier.verifyDLEQ(C1Proof, C3, C4, A1, A4, zrBytes, pkE);

        uint256 idx = submissions[taskId].length;
        submissions[taskId].push(Submission({
            contractor: msg.sender,
            C1Proof:    C1Proof,
            C1Decrypt:  C1Decrypt,
            C2:         C2,
            C3:         C3,
            C4:         C4,
            A1:         A1,
            A4:         A4,
            zrBytes:    zrBytes,
            pkE:        pkE,
            verified:   valid,
            rewarded:   false
        }));
        task.submissionCount++;

        if (!valid) {
            emit ContractorRejected(taskId, msg.sender, "Invalid DLEQ proof");
        }
        emit ResultSubmitted(taskId, msg.sender, idx, valid);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Finalization
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Group verified submissions by C3 (equality tag), elect the majority,
     *         record the winning ciphertext, and pay all majority contractors.
     *
     *  Equality test (pairing-free):
     *    EqTest(CT_i, CT_j) ≡ keccak256(CT_i.C3) == keccak256(CT_j.C3)
     *
     *  Complexity: O(n²) — acceptable for small contractor counts (≤ 20).
     *
     * @param taskId  Target task identifier.
     */
    function finalizeTask(uint256 taskId) public {
        Task storage task = tasks[taskId];
        require(task.id != 0,           "OutsourcedComputation: task does not exist");
        require(!task.finalized,        "OutsourcedComputation: already finalized");
        require(msg.sender == task.client, "OutsourcedComputation: only client can finalize");

        Submission[] storage subs = submissions[taskId];
        uint256 n = subs.length;
        require(n > 0, "OutsourcedComputation: no submissions");

        // ── Find majority C3 group ───────────────────────────────────────────
        bytes memory winC3;
        uint256 winCount = 0;
        uint256 winIdx   = type(uint256).max;

        for (uint256 i = 0; i < n; i++) {
            if (!subs[i].verified) continue;

            uint256 cnt = 0;
            for (uint256 j = 0; j < n; j++) {
                if (
                    subs[j].verified &&
                    DLEQVerifier.eqTest(subs[i].C3, subs[j].C3)
                ) {
                    cnt++;
                }
            }

            if (cnt > winCount) {
                winCount = cnt;
                winC3    = subs[i].C3;
                winIdx   = i;
            }
        }

        require(winCount > 0, "OutsourcedComputation: no valid submissions found");

        // ── Persist winning ciphertext ───────────────────────────────────────
        task.winningC1 = subs[winIdx].C1Decrypt;
        task.winningC2 = subs[winIdx].C2;
        task.winningC3 = winC3;
        task.finalized = true;

        // ── Pay majority contractors ─────────────────────────────────────────
        // Integer division: any remainder (dust) stays in the contract.
        uint256 perContractor = task.reward / winCount;

        for (uint256 i = 0; i < n; i++) {
            Submission storage s = subs[i];

            if (s.verified && DLEQVerifier.eqTest(s.C3, winC3) && !s.rewarded) {
                s.rewarded = true;
                (bool sent, ) = payable(s.contractor).call{value: perContractor}("");
                require(sent, "OutsourcedComputation: ETH transfer failed");
                emit ContractorRewarded(taskId, s.contractor, perContractor);

            } else if (s.verified && !DLEQVerifier.eqTest(s.C3, winC3)) {
                emit ContractorRejected(taskId, s.contractor, "Minority result");

            } else if (!s.verified) {
                emit ContractorRejected(taskId, s.contractor, "Invalid DLEQ proof");
            }
        }

        emit TaskFinalized(taskId, winC3, winCount, n);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // View helpers
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Return the winning ciphertext so the client can decrypt it off-chain.
     *         C1 and C2 are the ElGamal / ECIES components of one majority winner.
     */
    function getWinningCiphertext(
        uint256 taskId
    ) public view returns (
        bytes memory C1,
        bytes memory C2,
        bytes memory C3
    ) {
        Task storage task = tasks[taskId];
        require(task.finalized, "OutsourcedComputation: task not yet finalized");
        return (task.winningC1, task.winningC2, task.winningC3);
    }

    /// @notice Count of submitted ciphertexts (verified or not) for a task.
    function getSubmissionCount(uint256 taskId) public view returns (uint256) {
        return submissions[taskId].length;
    }

    /**
     * @notice Inspect a single submission (for off-chain auditing / decryption).
     *
     * @return contractor  Address that submitted.
     * @return C1          g^r
     * @return C2          ECIES(pk_d, D)
     * @return C3          H2(g^m) equality tag
     * @return C4          C3^r
     * @return verified    Did the DLEQ proof pass?
     * @return rewarded    Has this contractor been paid?
     */
    function getSubmission(
        uint256 taskId,
        uint256 idx
    ) public view returns (
        address contractor,
        bytes memory C1,
        bytes memory C2,
        bytes memory C3,
        bytes memory C4,
        bool verified,
        bool rewarded
    ) {
        Submission storage s = submissions[taskId][idx];
        return (s.contractor, s.C1Decrypt, s.C2, s.C3, s.C4, s.verified, s.rewarded);
    }

    /**
     * @notice Check whether any two submissions share the same equality tag,
     *         mirroring the equality test available to off-chain observers.
     */
    function equalityTest(
        uint256 taskId,
        uint256 idxI,
        uint256 idxJ
    ) public view returns (bool) {
        return DLEQVerifier.eqTest(
            submissions[taskId][idxI].C3,
            submissions[taskId][idxJ].C3
        );
    }
}
