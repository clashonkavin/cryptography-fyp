// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./BytesUtils.sol";
import "./Secp256k1.sol";

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
    /// @dev Curve group order
    uint256 private constant N =
        0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    /// @dev Generator x-coordinate
    uint256 private constant GX =
        0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798;

    /// @dev Generator y-coordinate
    uint256 private constant GY =
        0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8;

    // ─────────────────────────────────────────────────────────────────────────
    // Main verifier
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Verify a Chaum-Pedersen DLEQ proof that log_g(C1) = log_{C3}(C4).
     *
     * @param C1       33-byte compressed point  g^r
     * @param C3       33-byte compressed point  H2(g^m)
     * @param C4       33-byte compressed point  C3^r
     * @param A1       33-byte compressed point  g^kr   (proof nonce on g)
     * @param A4       33-byte compressed point  C3^kr  (proof nonce on C3)
     * @param zrBytes  32-byte big-endian scalar  zr = kr + e·r mod N
     * @param pkE      33-byte compressed contractor public key (binds proof to submitter)
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
        uint256 zr = BytesUtils.bytesToUint256(zrBytes);
        if (zr == 0 || zr >= N) return false;

        // ── 2.  Decompress all points ────────────────────────────────────────
        (uint256 C1x, uint256 C1y, bool ok1) = Secp256k1.decompressPoint(C1);
        (uint256 C3x, uint256 C3y, bool ok3) = Secp256k1.decompressPoint(C3);
        (uint256 C4x, uint256 C4y, bool ok4) = Secp256k1.decompressPoint(C4);
        (uint256 A1x, uint256 A1y, bool okA1) = Secp256k1.decompressPoint(A1);
        (uint256 A4x, uint256 A4y, bool okA4) = Secp256k1.decompressPoint(A4);

        if (!ok1 || !ok3 || !ok4 || !okA1 || !okA4) return false;

        // ── 3.  Reject degenerate inputs ─────────────────────────────────────
        // C1 = 1_G means r = 0 — no randomness used, insecure.
        if (C1x == 0 && C1y == 0) return false;
        // C4 = 1_G means either r = 0 or C3 is the identity, both invalid.
        if (C4x == 0 && C4y == 0) return false;
        // C3 itself must not be the identity (H2 must never output it).
        if (C3x == 0 && C3y == 0) return false;

        // ── 4.  Fiat-Shamir challenge ─────────────────────────────────────────
        //    e = sha256( A1 ‖ A4 ‖ C1 ‖ C3 ‖ C4 ‖ pk_e )  mod N
        //    Must match the hash computed by generateDLEQ() in crypto.js.
        uint256 e = uint256(
            sha256(abi.encodePacked(A1, A4, C1, C3, C4, pkE))
        ) % N;
        if (e == 0) return false;

        // ── 5.  Verification equation 1:  g^zr == A1 · C1^e ──────────────────
        {
            (uint256 lhsX, uint256 lhsY) = Secp256k1.scalarMul(GX, GY, zr);
            (uint256 eC1x, uint256 eC1y) = Secp256k1.scalarMul(C1x, C1y, e);
            (uint256 rhsX, uint256 rhsY) = Secp256k1.pointAdd(
                A1x, A1y, eC1x, eC1y
            );
            if (lhsX != rhsX || lhsY != rhsY) return false;
        }

        // ── 6.  Verification equation 2:  C3^zr == A4 · C4^e ─────────────────
        {
            (uint256 lhsX, uint256 lhsY) = Secp256k1.scalarMul(C3x, C3y, zr);
            (uint256 eC4x, uint256 eC4y) = Secp256k1.scalarMul(C4x, C4y, e);
            (uint256 rhsX, uint256 rhsY) = Secp256k1.pointAdd(
                A4x, A4y, eC4x, eC4y
            );
            if (lhsX != rhsX || lhsY != rhsY) return false;
        }

        return true;
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
