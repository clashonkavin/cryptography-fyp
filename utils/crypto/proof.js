const { BN } = require("bn.js");

const { G, N, compressPoint, decompressPoint, encodePointXY } = require("./ecc");
const { randomScalar, hashToScalar } = require("./scalars");

/**
 * Generate DLEQ proof: prove log_g(C1) = log_C3(C4) = r.
 *
 * @returns {{ A1: Buffer, A4: Buffer, zr: Buffer }}
 */
function generateProof({ C1, C3, C4, r }, pkE) {
  const k = randomScalar();
  const C3pt = decompressPoint(C3);

  const A1 = G.mul(k);
  const A4 = C3pt.mul(k);
  const A1buf = compressPoint(A1);
  const A4buf = compressPoint(A4);
  const A1xy = encodePointXY(A1);
  const A4xy = encodePointXY(A4);

  // Challenge e = H(A1 || A4 || C1 || C3 || C4 || pkE) mod N
  const e = hashToScalar(A1buf, A4buf, C1, C3, C4, pkE);
  const zr = k.add(e.mul(r)).umod(N);
  const zrBuf = Buffer.from(zr.toString(16, 64), "hex");
  return { A1: A1buf, A4: A4buf, A1xy, A4xy, zr: zrBuf };
}

/**
 * Verify DLEQ proof off-chain (mirror of on-chain logic).
 *
 * Check 1: g^zr == A1 + e*C1
 * Check 2: C3^zr == A4 + e*C4
 */
function verifyProof({ C1, C3, C4, A1, A4, zr }, pkEBytes) {
  const zrBN = new BN(zr.toString("hex"), 16);
  const C1pt = decompressPoint(C1);
  const C3pt = decompressPoint(C3);
  const C4pt = decompressPoint(C4);
  const A1pt = decompressPoint(A1);
  const A4pt = decompressPoint(A4);

  const e = hashToScalar(A1, A4, C1, C3, C4, pkEBytes);

  const lhs1 = G.mul(zrBN);
  const rhs1 = A1pt.add(C1pt.mul(e));
  if (!lhs1.eq(rhs1)) return false;

  const lhs2 = C3pt.mul(zrBN);
  const rhs2 = A4pt.add(C4pt.mul(e));
  return lhs2.eq(rhs2);
}

module.exports = {
  generateProof,
  verifyProof,
};

