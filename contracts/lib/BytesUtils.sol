// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

library BytesUtils {
    /**
     * @dev Constant-time equality check for arbitrary byte arrays.
     *      Using keccak256 avoids a loop and is safe for comparing
     *      compressed elliptic-curve points (fixed 33-byte blobs).
     */
    function bytesEqual(
        bytes memory a,
        bytes memory b
    ) internal pure returns (bool) {
        return keccak256(a) == keccak256(b);
    }

    /**
     * @dev Decode a big-endian 32-byte blob into a uint256.
     *      Used to deserialise zr scalars submitted by contractors.
     */
    function bytesToUint256(bytes memory b) internal pure returns (uint256 v) {
        require(b.length == 32, "BytesUtils: expected 32 bytes");
        assembly {
            v := mload(add(b, 32))
        }
    }
}
