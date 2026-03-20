/**
 * crypto.js (compat shim)
 *
 * The original implementation was monolithic. This file now re-exports the
 * split modules under `utils/crypto/` so existing code can keep using:
 *   require("../utils/crypto")
 */

const { G, N, compressPoint, decompressPoint } = require("./crypto/ecc");
const { H_POINT } = require("./crypto/generators");
const { hashToScalar, valueToScalar } = require("./crypto/scalars");
const { generateKeyPair } = require("./crypto/keygen");
const { encrypt } = require("./crypto/encrypt");
const { generateProof, verifyProof } = require("./crypto/proof");
const { decrypt } = require("./crypto/decrypt");

module.exports = {
  // public API used by scripts/tests
  generateKeyPair,
  encrypt,
  generateProof,
  verifyProof,
  decrypt,

  // exposed primitives (kept for backwards compatibility)
  compressPoint,
  decompressPoint,
  valueToScalar,
  hashToScalar,
  H_POINT,
  G,
  N,
};

