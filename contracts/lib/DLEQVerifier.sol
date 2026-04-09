// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./BytesUtils.sol";

/**
 * @title DLEQVerifier
 * @notice On-chain verifier for Chaum-Pedersen Discrete-Log Equality (DLEQ) proofs
 *         over secp256k1, used in the pairing-free PKEET-LE construction.
 *
 * ─── Scheme recap ────────────────────────────────────────────────────────────
 *
 * Ciphertext:
 *   CT = ( C1, C2, C3, C4, π )
 *   where
 *     m  = H(D)                 — result digest mapped to Z_p
 *     r  ∈ Z_p                  — fresh encryption randomness
 *     C1 = g^r                  — ElGamal component 1
 *     C2 = ECIES(pk_d, D)       — hybrid encryption of raw data D
 *     C3 = H2(g^m)              — equality tag base (hash-to-group of g^m)
 *     C4 = C3^r                 — equality tag commitment
 *     π  = (A1, A4, zr)         — DLEQ proof
 *
 * DLEQ proof (prover side, in crypto.js):
 *   kr ← Z_p
 *   A1  = g^kr
 *   A4  = C3^kr
 *   e   = H1( A1 ‖ A4 ‖ C1 ‖ C3 ‖ C4 ‖ pk_e )   mod N
 *   zr  = kr + e·r   mod N
 *
 * Verification (this contract):
 *   1. Reject if C1 = 1_G  (point at infinity)
 *   2. Reject if C4 = 1_G
 *   3. e   = sha256( A1 ‖ A4 ‖ C1 ‖ C3 ‖ C4 ‖ pk_e )   mod N
 *   4. g^zr  ==  A1 · C1^e       (check discrete log consistency w.r.t. g)
 *   5. C3^zr ==  A4 · C4^e       (check discrete log consistency w.r.t. C3)
 *
 * Equality test (in OutsourcedComputation.finalizeTask):
 *   EqTest( CT_i, CT_j )  ≡  ( CT_i.C3 == CT_j.C3 )
 *   — purely a byte comparison, no pairing required.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */
library DLEQVerifier {
    uint256 private constant R =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    uint256 private constant GX = 1;
    uint256 private constant GY = 2;

    // ─────────────────────────────────────────────────────────────────────────
    // Main verifier
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Verify a Chaum-Pedersen DLEQ proof that log_g(C1) = log_{C3}(C4).
     *
     * @param C1       64-byte BN254 G1 point (x||y) g^r
     * @param C3       64-byte BN254 G1 point (x||y)
     * @param C4       64-byte BN254 G1 point (x||y)
     * @param A1       64-byte BN254 G1 point (x||y)
     * @param A4       64-byte BN254 G1 point (x||y)
     * @param zrBytes  32-byte big-endian scalar  zr = kr + e·r mod N
     * @param pkE      64-byte BN254 G1 public key (binds proof to submitter)
     *
     * @return bool  true iff the proof is valid and no degenerate inputs were found.
     */
    function verifyDLEQ(
        bytes memory C1,
        bytes memory C3,
        bytes memory C4,
        bytes memory A1,
        bytes memory A4,
        bytes memory zrBytes,
        bytes memory pkE
    ) internal view returns (bool) {

        // ── 1.  Scalar sanity ────────────────────────────────────────────────
        uint256 zr = BytesUtils.bytesToUint256(zrBytes) % R;
        if (zr == 0) return false;

        // ── 4.  Fiat-Shamir challenge ─────────────────────────────────────────
        //    e = sha256( A1 ‖ A4 ‖ C1 ‖ C3 ‖ C4 ‖ pk_e )  mod N
        //    Must match the hash computed by generateDLEQ() in crypto.js.
        uint256 e = uint256(sha256(abi.encodePacked(A1, A4, C1, C3, C4, pkE))) % R;
        if (e == 0) return false;

        (uint256 C1x, uint256 C1y, bool ok1) = _readPointXY(C1);
        (uint256 C3x, uint256 C3y, bool ok3) = _readPointXY(C3);
        (uint256 C4x, uint256 C4y, bool ok4) = _readPointXY(C4);
        (uint256 A1x, uint256 A1y, bool okA1) = _readPointXY(A1);
        (uint256 A4x, uint256 A4y, bool okA4) = _readPointXY(A4);
        if (!ok1 || !ok3 || !ok4 || !okA1 || !okA4) return false;
        if (C1x == 0 && C1y == 0) return false;
        if (C3x == 0 && C3y == 0) return false;
        if (C4x == 0 && C4y == 0) return false;

        return
            _verifyEq1(C1x, C1y, A1x, A1y, e, zr) &&
            _verifyEq2(C3x, C3y, C4x, C4y, A4x, A4y, e, zr);
    }

    function _verifyEq1(
        uint256 C1x,
        uint256 C1y,
        uint256 A1x,
        uint256 A1y,
        uint256 e,
        uint256 zr
    ) private view returns (bool) {
        (uint256 lhsX, uint256 lhsY, bool okL) = _g1Mul(GX, GY, zr);
        (uint256 eC1x, uint256 eC1y, bool okE) = _g1Mul(C1x, C1y, e);
        if (!okL || !okE) return false;
        (uint256 rhsX, uint256 rhsY, bool okR) = _g1Add(A1x, A1y, eC1x, eC1y);
        if (!okR) return false;
        return lhsX == rhsX && lhsY == rhsY;
    }

    function _verifyEq2(
        uint256 C3x,
        uint256 C3y,
        uint256 C4x,
        uint256 C4y,
        uint256 A4x,
        uint256 A4y,
        uint256 e,
        uint256 zr
    ) private view returns (bool) {
        (uint256 lhsX, uint256 lhsY, bool okL) = _g1Mul(C3x, C3y, zr);
        (uint256 eC4x, uint256 eC4y, bool okE) = _g1Mul(C4x, C4y, e);
        if (!okL || !okE) return false;
        (uint256 rhsX, uint256 rhsY, bool okR) = _g1Add(A4x, A4y, eC4x, eC4y);
        if (!okR) return false;
        return lhsX == rhsX && lhsY == rhsY;
    }

    function _readPointXY(bytes memory b) private pure returns (uint256 x, uint256 y, bool ok) {
        if (b.length != 64) return (0, 0, false);
        assembly {
            x := mload(add(b, 0x20))
            y := mload(add(b, 0x40))
        }
        ok = true;
    }

    function _g1Add(
        uint256 x1,
        uint256 y1,
        uint256 x2,
        uint256 y2
    ) private view returns (uint256 x3, uint256 y3, bool ok) {
        uint256[4] memory input = [x1, y1, x2, y2];
        uint256[2] memory out;
        assembly {
            ok := staticcall(gas(), 6, input, 0x80, out, 0x40)
        }
        if (!ok) return (0, 0, false);
        return (out[0], out[1], true);
    }

    function _g1Mul(
        uint256 x,
        uint256 y,
        uint256 s
    ) private view returns (uint256 rx, uint256 ry, bool ok) {
        uint256[3] memory input = [x, y, s];
        uint256[2] memory out;
        assembly {
            ok := staticcall(gas(), 7, input, 0x60, out, 0x40)
        }
        if (!ok) return (0, 0, false);
        return (out[0], out[1], true);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Equality test helper (exposed so the main contract stays clean)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Pairing-free equality test.
     *         Two ciphertexts encrypt the same plaintext iff their C3 tags match.
     *         C3 = H2(g^m) depends only on m = H(D), so identical results share
     *         the same tag regardless of the randomness r used.
     *
     * @param C3i  Equality tag from ciphertext i
     * @param C3j  Equality tag from ciphertext j
     */
    function eqTest(
        bytes memory C3i,
        bytes memory C3j
    ) internal pure returns (bool) {
        return BytesUtils.bytesEqual(C3i, C3j);
    }
}
