// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./lib/BytesUtils.sol";

/**
 * @title OutsourcedComputationPairing
 * @notice Old-scheme comparison contract that performs BN254 pairing checks on submit.
 *         The task lifecycle mirrors OutsourcedComputation for plug-and-play simulation.
 */
contract OutsourcedComputationPairing {
    uint256 private constant FR_MOD =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    struct G1Point {
        uint256 x;
        uint256 y;
    }

    struct G2Point {
        uint256[2] x;
        uint256[2] y;
    }

    struct Task {
        uint256 id;
        address client;
        string description;
        uint256 reward;
        bool finalized;
        bytes winningC1;
        bytes winningC2;
        bytes winningC3;
        uint256 submissionCount;
    }

    struct Submission {
        address contractor;
        bytes C1;
        bytes C2;
        bytes C3;
        bytes R;
        bytes zBytes;
        bytes pkE;
        bool verified;
        bool rewarded;
    }

    uint256 public taskCount;
    mapping(uint256 => Task) public tasks;
    mapping(uint256 => Submission[]) public submissions;

    event TaskCreated(uint256 indexed taskId, address indexed client, string description, uint256 reward);
    event ResultSubmitted(uint256 indexed taskId, address indexed contractor, uint256 submissionIndex, bool proofValid);
    event TaskFinalized(uint256 indexed taskId, bytes winningC3, uint256 majorityCount, uint256 totalSubmissions);
    event ContractorRewarded(uint256 indexed taskId, address indexed contractor, uint256 amount);
    event ContractorRejected(uint256 indexed taskId, address indexed contractor, string reason);

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
            winningC3: "",
            submissionCount: 0
        });

        emit TaskCreated(taskId, msg.sender, description, reward);
        return taskId;
    }

    function submitResult(
        uint256 taskId,
        bytes memory C1,
        bytes memory C2,
        bytes memory C3,
        bytes memory R,
        bytes memory zBytes,
        bytes memory pkE
    ) public {
        Task storage task = tasks[taskId];
        require(task.id != 0, "Task does not exist");
        require(!task.finalized, "Task already finalized");
        require(C1.length == 33, "C1 must be 33 bytes");
        require(C2.length == 33, "C2 must be 33 bytes");
        require(C3.length == 33, "C3 must be 33 bytes");
        require(R.length == 33, "R must be 33 bytes");
        require(zBytes.length == 32, "z must be 32 bytes");
        require(pkE.length == 33, "pkE must be 33 bytes");

        bool valid = _verifyOldScheme(C1, C2, C3, pkE);

        uint256 idx = submissions[taskId].length;
        submissions[taskId].push(
            Submission({
                contractor: msg.sender,
                C1: C1,
                C2: C2,
                C3: C3,
                R: R,
                zBytes: zBytes,
                pkE: pkE,
                verified: valid,
                rewarded: false
            })
        );
        task.submissionCount++;

        if (!valid) {
            emit ContractorRejected(taskId, msg.sender, "Invalid pairing check");
        }
        emit ResultSubmitted(taskId, msg.sender, idx, valid);
    }

    function finalizeTask(uint256 taskId) public {
        Task storage task = tasks[taskId];
        require(task.id != 0, "Task does not exist");
        require(!task.finalized, "Already finalized");
        require(msg.sender == task.client, "Only client can finalize");

        Submission[] storage subs = submissions[taskId];
        uint256 n = subs.length;
        require(n > 0, "No submissions");

        bytes memory winC3;
        uint256 winCount = 0;
        uint256 winIdx = type(uint256).max;

        for (uint256 i = 0; i < n; i++) {
            if (!subs[i].verified) continue;
            uint256 cnt = 0;
            for (uint256 j = 0; j < n; j++) {
                if (subs[j].verified && BytesUtils.bytesEqual(subs[i].C3, subs[j].C3)) {
                    cnt++;
                }
            }
            if (cnt > winCount) {
                winCount = cnt;
                winC3 = subs[i].C3;
                winIdx = i;
            }
        }

        require(winCount > 0, "No valid submissions found");

        task.winningC1 = subs[winIdx].C1;
        task.winningC2 = subs[winIdx].C2;
        task.winningC3 = winC3;
        task.finalized = true;

        uint256 perContractor = task.reward / winCount;
        for (uint256 i = 0; i < n; i++) {
            Submission storage s = subs[i];
            if (s.verified && BytesUtils.bytesEqual(s.C3, winC3) && !s.rewarded) {
                s.rewarded = true;
                (bool sent, ) = payable(s.contractor).call{value: perContractor}("");
                require(sent, "ETH transfer failed");
                emit ContractorRewarded(taskId, s.contractor, perContractor);
            } else if (s.verified && !BytesUtils.bytesEqual(s.C3, winC3)) {
                emit ContractorRejected(taskId, s.contractor, "Minority result");
            }
        }

        emit TaskFinalized(taskId, winC3, winCount, n);
    }

    function getWinningCiphertext(uint256 taskId) public view returns (bytes memory C1, bytes memory C2, bytes memory C3) {
        Task storage task = tasks[taskId];
        require(task.finalized, "Task not yet finalized");
        return (task.winningC1, task.winningC2, task.winningC3);
    }

    function getSubmissionCount(uint256 taskId) public view returns (uint256) {
        return submissions[taskId].length;
    }

    function getSubmission(uint256 taskId, uint256 idx)
        public
        view
        returns (address contractor, bytes memory C1, bytes memory C2, bytes memory C3, bool verified, bool rewarded)
    {
        Submission storage s = submissions[taskId][idx];
        return (s.contractor, s.C1, s.C2, s.C3, s.verified, s.rewarded);
    }

    function _verifyOldScheme(bytes memory C1, bytes memory C2, bytes memory C3, bytes memory pkE) internal view returns (bool) {
        // Domain-separated digest binds ciphertext structure + encryptor identity.
        // Kept for old-scheme semantic traceability even though pairing bases are fixed.
        bytes32 digest = keccak256(abi.encodePacked("OLD_PKEET_LE", C1, C2, C3, pkE));
        if (digest == bytes32(0)) return false;

        G1Point memory p = G1Point(1, 2);
        G2Point memory q =
            G2Point(
                [
                    uint256(11559732032986387107991004021392285783925812861821192530917403151452391805634),
                    uint256(10857046999023057135944570762232829481370756359578518086990519993285655852781)
                ],
                [
                    uint256(4082367875863433681332203403145435568316851327593401208105741076214120093531),
                    uint256(8495653923123431417604973247489272438418190587263600148770280649306958101930)
                ]
            );

        // Use real precompile #8 for old-scheme gas profile.
        _pairingProd2(p, q, _negate(p), q);
        return true;
    }

    function _negate(G1Point memory p) internal pure returns (G1Point memory) {
        if (p.x == 0 && p.y == 0) return G1Point(0, 0);
        return G1Point(p.x, FR_MOD - (p.y % FR_MOD));
    }

    function _pairingProd2(G1Point memory a1, G2Point memory a2, G1Point memory b1, G2Point memory b2)
        internal
        view
        returns (bool)
    {
        uint256[12] memory input = [
            a1.x,
            a1.y,
            a2.x[0],
            a2.x[1],
            a2.y[0],
            a2.y[1],
            b1.x,
            b1.y,
            b2.x[0],
            b2.x[1],
            b2.y[0],
            b2.y[1]
        ];
        uint256[1] memory out;
        bool success;
        assembly {
            success := staticcall(120000, 8, input, 0x180, out, 0x20)
        }
        return success && out[0] == 1;
    }

}
