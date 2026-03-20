// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

library BytesUtils {
    function bytesEqual(
        bytes memory a,
        bytes memory b
    ) internal pure returns (bool) {
        return keccak256(a) == keccak256(b);
    }

    function bytesToUint256(bytes memory b) internal pure returns (uint256 v) {
        require(b.length == 32, "Expected 32 bytes");
        assembly {
            v := mload(add(b, 32))
        }
    }
}
