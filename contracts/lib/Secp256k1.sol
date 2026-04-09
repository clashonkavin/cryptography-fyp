// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title Secp256k1
 * @notice Affine-coordinate secp256k1 arithmetic used by DLEQVerifier.
 *
 * Design notes:
 *  - Point at infinity is encoded as (0, 0).
 *  - Modular inverse is computed via the modexp precompile (EIP-198 / 0x05),
 *    which is ~100x cheaper than a Solidity loop for 256-bit exponents.
 *  - All arithmetic is in the base field Fp (prime P), not the scalar field FN.
 */
library Secp256k1 {
    /// @dev Curve field prime  p = 2^256 − 2^32 − 2^9 − 2^8 − 2^7 − 2^6 − 2^4 − 1
    uint256 internal constant P =
        0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F;

    /// @dev Curve group order n
    uint256 internal constant N =
        0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

    /// @dev Generator x-coordinate
    uint256 internal constant GX =
        0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798;

    /// @dev Generator y-coordinate
    uint256 internal constant GY =
        0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8;

    // ─────────────────────────────────────────────────────────────────────────
    // Core group operations
    // ─────────────────────────────────────────────────────────────────────────

    struct JacobianPoint {
        uint256 X;
        uint256 Y;
        uint256 Z; // Z == 0 encodes infinity
    }

    /**
     * @dev Scalar multiplication: returns scalar * (px, py).
     *      Uses Jacobian coordinates to avoid per-step inversions.
     */
    function scalarMul(
        uint256 px,
        uint256 py,
        uint256 scalar
    ) internal view returns (uint256 qx, uint256 qy) {
        if (scalar == 0) return (0, 0);
        scalar = scalar % N;
        if (scalar == 0) return (0, 0);

        JacobianPoint memory Q = JacobianPoint(0, 1, 0); // infinity
        JacobianPoint memory A = _toJacobian(px, py);

        while (scalar > 0) {
            if (scalar & 1 == 1) {
                Q = _jacobianAdd(Q, A);
            }
            A = _jacobianDouble(A);
            scalar >>= 1;
        }

        (qx, qy) = _toAffine(Q);
    }

    /**
     * @dev Affine point addition.  Handles the point-at-infinity identity
     *      and the degenerate case x1 == x2 (doubling or inverse).
     */
    function pointAdd(
        uint256 x1,
        uint256 y1,
        uint256 x2,
        uint256 y2
    ) internal view returns (uint256 x3, uint256 y3) {
        if (x1 == 0 && y1 == 0) return (x2, y2);
        if (x2 == 0 && y2 == 0) return (x1, y1);

        if (x1 == x2) {
            if (y1 == y2) return pointDouble(x1, y1);
            return (0, 0); // P + (-P) = identity
        }

        // λ = (y2 − y1) / (x2 − x1)  mod P
        uint256 lam = mulmod(
            addmod(y2, P - y1, P),
            modInv(addmod(x2, P - x1, P), P),
            P
        );
        x3 = addmod(mulmod(lam, lam, P), P - addmod(x1, x2, P), P);
        y3 = addmod(mulmod(lam, addmod(x1, P - x3, P), P), P - y1, P);
    }

    /**
     * @dev Affine point doubling.
     *      λ = 3x² / (2y)  mod P
     */
    function pointDouble(
        uint256 x,
        uint256 y
    ) internal view returns (uint256 x2, uint256 y2) {
        if (x == 0 && y == 0) return (0, 0);

        uint256 lam = mulmod(
            mulmod(3, mulmod(x, x, P), P),
            modInv(mulmod(2, y, P), P),
            P
        );
        x2 = addmod(mulmod(lam, lam, P), P - addmod(x, x, P), P);
        y2 = addmod(mulmod(lam, addmod(x, P - x2, P), P), P - y, P);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Jacobian helpers (a=0 curve: y^2 = x^3 + 7)
    // ─────────────────────────────────────────────────────────────────────────

    function _toJacobian(uint256 x, uint256 y) private pure returns (JacobianPoint memory p) {
        if (x == 0 && y == 0) return JacobianPoint(0, 1, 0);
        return JacobianPoint(x, y, 1);
    }

    function _toAffine(JacobianPoint memory p) private view returns (uint256 x, uint256 y) {
        if (p.Z == 0) return (0, 0);
        uint256 zInv = modInv(p.Z, P);
        uint256 zInv2 = mulmod(zInv, zInv, P);
        uint256 zInv3 = mulmod(zInv2, zInv, P);
        x = mulmod(p.X, zInv2, P);
        y = mulmod(p.Y, zInv3, P);
    }

    // Jacobian doubling for a=0:
    // https://www.hyperelliptic.org/EFD/g1p/auto-shortw-jacobian-0.html#doubling-dbl-2009-l
    function _jacobianDouble(JacobianPoint memory p) private pure returns (JacobianPoint memory r) {
        if (p.Z == 0) return p;
        if (p.Y == 0) return JacobianPoint(0, 1, 0);

        uint256 XX = mulmod(p.X, p.X, P);           // X1^2
        uint256 YY = mulmod(p.Y, p.Y, P);           // Y1^2
        uint256 YYYY = mulmod(YY, YY, P);           // Y1^4
        uint256 ZZ = mulmod(p.Z, p.Z, P);           // Z1^2

        uint256 S = mulmod(4, mulmod(p.X, YY, P), P); // S = 4*X1*Y1^2
        uint256 M = mulmod(3, XX, P);                 // M = 3*X1^2 (a=0)

        uint256 X3 = addmod(mulmod(M, M, P), P - addmod(S, S, P), P);
        uint256 Y3 = addmod(mulmod(M, addmod(S, P - X3, P), P), P - mulmod(8, YYYY, P), P);
        uint256 Z3 = mulmod(2, mulmod(p.Y, p.Z, P), P);

        // ZZ is unused but kept in structure to match common formula components.
        ZZ;
        return JacobianPoint(X3, Y3, Z3);
    }

    // Jacobian addition (complete for generic case; handles infinity; non-complete for all edge cases but safe for our use with scalar mul loop)
    // https://www.hyperelliptic.org/EFD/g1p/auto-shortw-jacobian-0.html#addition-add-2007-bl
    function _jacobianAdd(JacobianPoint memory p, JacobianPoint memory q) private pure returns (JacobianPoint memory r) {
        if (p.Z == 0) return q;
        if (q.Z == 0) return p;

        uint256 Z1Z1 = mulmod(p.Z, p.Z, P);
        uint256 Z2Z2 = mulmod(q.Z, q.Z, P);
        uint256 U1 = mulmod(p.X, Z2Z2, P);
        uint256 U2 = mulmod(q.X, Z1Z1, P);
        uint256 S1 = mulmod(p.Y, mulmod(q.Z, Z2Z2, P), P);
        uint256 S2 = mulmod(q.Y, mulmod(p.Z, Z1Z1, P), P);

        if (U1 == U2) {
            if (S1 == S2) return _jacobianDouble(p);
            return JacobianPoint(0, 1, 0);
        }

        uint256 H = addmod(U2, P - U1, P);
        uint256 HH = mulmod(H, H, P);
        uint256 HHH = mulmod(H, HH, P);
        uint256 R = addmod(S2, P - S1, P);
        uint256 V = mulmod(U1, HH, P);

        uint256 X3 = addmod(addmod(mulmod(R, R, P), P - HHH, P), P - addmod(V, V, P), P);
        uint256 Y3 = addmod(mulmod(R, addmod(V, P - X3, P), P), P - mulmod(S1, HHH, P), P);
        uint256 Z3 = mulmod(H, mulmod(p.Z, q.Z, P), P);
        return JacobianPoint(X3, Y3, Z3);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Field helpers
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @dev Modular inverse via Fermat's little theorem: a^(m-2) mod m.
     *      Valid because P is prime.
     */
    function modInv(uint256 a, uint256 m) internal view returns (uint256) {
        return modExp(a, m - 2, m);
    }

    /**
     * @dev Modular exponentiation via the EVM precompile at address 0x05
     *      (EIP-198).  Input format: <Bsize:32><Esize:32><Msize:32><B><E><M>.
     */
    function modExp(
        uint256 base,
        uint256 exp,
        uint256 mod
    ) internal view returns (uint256 result) {
        if (mod == 1) return 0;
        if (exp == 0) return 1 % mod;
        if (base == 0) return 0;

        bytes memory input = abi.encodePacked(
            uint256(32), // length of base
            uint256(32), // length of exp
            uint256(32), // length of mod
            base,
            exp,
            mod
        );
        bytes memory output = new bytes(32);

        bool ok;
        assembly {
            ok := staticcall(
                gas(),
                5,
                add(input, 0x20),
                mload(input),
                add(output, 0x20),
                0x20
            )
        }
        require(ok, "Secp256k1: modexp precompile failed");

        assembly {
            result := mload(add(output, 0x20))
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Point encoding / decoding
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @dev Decompress a 33-byte SEC-encoded point.
     *      Prefix 0x02 → even y,  0x03 → odd y.
     *      Returns (x, y, true) on success, (0, 0, false) on failure.
     *
     *      Curve equation: y² = x³ + 7  mod P.
     *      Because P ≡ 3 (mod 4), the square root is y = rhs^((P+1)/4) mod P.
     */
    function decompressPoint(
        bytes memory compressed
    ) internal view returns (uint256 x, uint256 y, bool ok) {
        if (compressed.length != 33) return (0, 0, false);

        uint8 prefix = uint8(compressed[0]);
        if (prefix != 0x02 && prefix != 0x03) return (0, 0, false);

        // Read x from bytes 1..32
        x = 0;
        for (uint256 i = 1; i < 33; i++) {
            x = (x << 8) | uint8(compressed[i]);
        }

        // y² = x³ + 7 mod P
        uint256 rhs = addmod(mulmod(mulmod(x, x, P), x, P), 7, P);

        // y = rhs^((P+1)/4) mod P
        y = modExp(rhs, (P + 1) / 4, P);

        // Verify the square root is correct
        if (mulmod(y, y, P) != rhs) return (0, 0, false);

        // Choose the correct parity
        if ((y & 1) != (prefix & 1)) y = P - y;

        ok = true;
    }

    /**
     * @dev Compress an affine point to its 33-byte SEC representation.
     *      Returns the point-at-infinity encoding (33 zero bytes) when
     *      x == 0 && y == 0.
     */
    function compressPoint(
        uint256 x,
        uint256 y
    ) internal pure returns (bytes memory out) {
        out = new bytes(33);
        if (x == 0 && y == 0) return out; // point at infinity
        out[0] = (y & 1 == 0) ? bytes1(0x02) : bytes1(0x03);
        for (uint256 i = 0; i < 32; i++) {
            out[32 - i] = bytes1(uint8(x >> (8 * i)));
        }
    }
}
