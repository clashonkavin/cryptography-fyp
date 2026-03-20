// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * secp256k1 elliptic curve arithmetic used for on-chain Schnorr verification.
 *
 * Notes:
 * - Uses only simple Jacobian-less affine formulas.
 * - The point at infinity is encoded as (0,0).
 * - This implementation relies on modular inverse via the `modexp` precompile (0x05).
 */
library Secp256k1 {
    // Curve order n
    uint256 internal constant N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
    // Field prime p
    uint256 internal constant P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F;
    // Generator point
    uint256 internal constant GX = 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798;
    uint256 internal constant GY = 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8;

    function scalarMul(uint256 px, uint256 py, uint256 scalar)
        internal
        view
        returns (uint256 qx, uint256 qy)
    {
        if (scalar == 0) return (0, 0);
        scalar = scalar % N;

        uint256 ax = px;
        uint256 ay = py;
        qx = 0;
        qy = 0;

        while (scalar > 0) {
            if (scalar & 1 == 1) {
                (qx, qy) = pointAdd(qx, qy, ax, ay);
            }
            (ax, ay) = pointDouble(ax, ay);
            scalar >>= 1;
        }
    }

    function pointAdd(uint256 x1, uint256 y1, uint256 x2, uint256 y2)
        internal
        view
        returns (uint256 x3, uint256 y3)
    {
        if (x1 == 0 && y1 == 0) return (x2, y2);
        if (x2 == 0 && y2 == 0) return (x1, y1);

        if (x1 == x2) {
            if (y1 == y2) return pointDouble(x1, y1);
            return (0, 0); // point at infinity
        }

        // lam = (y2 - y1) / (x2 - x1)
        uint256 lam = mulmod(addmod(y2, P - y1, P), modInv(addmod(x2, P - x1, P), P), P);

        x3 = addmod(mulmod(lam, lam, P), P - addmod(x1, x2, P), P);
        y3 = addmod(mulmod(lam, addmod(x1, P - x3, P), P), P - y1, P);
    }

    function pointDouble(uint256 x, uint256 y)
        internal
        view
        returns (uint256 x2, uint256 y2)
    {
        if (x == 0 && y == 0) return (0, 0);

        // lam = (3*x^2) / (2*y)
        uint256 lam = mulmod(
            mulmod(3, mulmod(x, x, P), P),
            modInv(mulmod(2, y, P), P),
            P
        );

        x2 = addmod(mulmod(lam, lam, P), P - addmod(x, x, P), P);
        y2 = addmod(mulmod(lam, addmod(x, P - x2, P), P), P - y, P);
    }

    function modInv(uint256 a, uint256 m) internal view returns (uint256) {
        // Fermat inversion (m is prime): a^(m-2) mod m
        return modExp(a, m - 2, m);
    }

    function modExp(uint256 base, uint256 exp, uint256 mod) internal view returns (uint256 result) {
        // Use the EVM modexp precompile (address 0x05) which is dramatically cheaper than
        // a Solidity loop for 256-bit exponents.
        if (mod == 1) return 0;
        if (exp == 0) return 1 % mod;
        if (base == 0) return 0;

        // Format per EIP-198:
        //   <Bsize:32><Esize:32><Msize:32><base><exp><mod>
        bytes memory input = abi.encodePacked(
            uint256(32), // Bsize
            uint256(32), // Esize
            uint256(32), // Msize
            base,
            exp,
            mod
        );
        bytes memory output = new bytes(32);

        bool ok;
        assembly {
            ok := staticcall(
                gas(),
                5, // modexp precompile
                add(input, 0x20),
                mload(input),
                add(output, 0x20),
                0x20
            )
        }
        require(ok, "modexp precompile failed");

        assembly {
            result := mload(add(output, 0x20))
        }
    }

    /**
     * @dev Decompress a 33-byte secp256k1 point. First byte is 0x02 or 0x03.
     */
    function decompressPoint(bytes memory compressed)
        internal
        view
        returns (uint256 x, uint256 y, bool ok)
    {
        if (compressed.length != 33) return (0, 0, false);
        uint8 prefix = uint8(compressed[0]);
        if (prefix != 0x02 && prefix != 0x03) return (0, 0, false);

        x = 0;
        for (uint256 i = 1; i < 33; i++) {
            x = (x << 8) | uint8(compressed[i]);
        }

        // y^2 = x^3 + 7 mod P
        uint256 rhs = addmod(mulmod(mulmod(x, x, P), x, P), 7, P);
        y = modExp(rhs, (P + 1) / 4, P); // works because P % 4 == 3

        if (mulmod(y, y, P) != rhs) return (0, 0, false);
        if ((y & 1) != (prefix & 1)) y = P - y;
        ok = true;
    }
}

