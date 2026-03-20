const { BN } = require("bn.js");

const { G, N, compressPoint, decompressPoint } = require("./ecc");
const { randomScalar, hashToScalar } = require("./scalars");

/**
 * Generate Schnorr proof: prove knowledge of r s.t. C1 = g^r.
 *
 * @returns {{ R: Buffer, z: Buffer }}
 */
function generateProof({ C1, C2, C4, r }, pkE) {
  const k = randomScalar();
  const R = G.mul(k);
  const Rbuf = compressPoint(R);

  // Challenge e = H(R || C1 || C2 || C4 || pkE) mod N
  const e = hashToScalar(Rbuf, C1, C2, C4, pkE);

  // Response z = k + e*r mod N
  const z = k.add(e.mul(r)).umod(N);

  // Pad z to 32 bytes
  const zBuf = Buffer.from(z.toString(16, 64), "hex");
  return { R: Rbuf, z: zBuf };
}

/**
 * Verify Schnorr proof off-chain (mirror of on-chain logic).
 *
 * Check: g^z == R + e*C1
 */
function verifyProof({ C1, C2, C4, R, z }, pkEBytes) {
  const zBN = new BN(z.toString("hex"), 16);
  const C1pt = decompressPoint(C1);
  const Rpt = decompressPoint(R);

  const e = hashToScalar(R, C1, C2, C4, pkEBytes);

  const lhs = G.mul(zBN); // g^z
  const rhs = Rpt.add(C1pt.mul(e)); // R + e*C1

  return lhs.eq(rhs);
}

module.exports = {
  generateProof,
  verifyProof,
};

