// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./BytesUtils.sol";
import "./Secp256k1.sol";

/**
 * Schnorr proof verification (PoK of encryption randomness r) over secp256k1.
 *
 * We check (additive notation):
 *   g^z == R + e*C1
 * where e = sha256(R || C1 || C2 || C4 || pkE) mod N.
 */
library SchnorrVerifier {
    // Curve order n
    uint256 private constant N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
    // Generator point
    uint256 private constant GX = 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798;
    uint256 private constant GY = 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8;

    function verifySchnorr(
        bytes memory C1,
        bytes memory C2,
        bytes memory C4,
        bytes memory R,
        bytes memory zBytes,
        bytes memory pkE
    ) internal view returns (bool) {
        // Must match utils/crypto.js which uses SHA-256 for challenge derivation.
        uint256 e = uint256(sha256(abi.encodePacked(R, C1, C2, C4, pkE))) % N;
        uint256 z = BytesUtils.bytesToUint256(zBytes);

        if (z == 0 || z >= N) return false;
        if (e == 0) return false;

        // Decompress points
        (uint256 C1x, uint256 C1y, bool ok1) = Secp256k1.decompressPoint(C1);
        (uint256 Rx, uint256 Ry, bool ok2) = Secp256k1.decompressPoint(R);
        if (!ok1 || !ok2) return false;

        // LHS = g^z
        (uint256 lhsX, uint256 lhsY) = Secp256k1.scalarMul(GX, GY, z);

        // RHS = R + e*C1
        (uint256 eC1x, uint256 eC1y) = Secp256k1.scalarMul(C1x, C1y, e);
        (uint256 rhsX, uint256 rhsY) = Secp256k1.pointAdd(Rx, Ry, eC1x, eC1y);

        return (lhsX == rhsX && lhsY == rhsY);
    }
}

