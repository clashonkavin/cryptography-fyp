const { G, compressPoint, decompressPoint } = require("./ecc");
const { valueToScalar } = require("./scalars");

function range(from, to) {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

/**
 * Decrypt ciphertext (C1, C2) with client's secret key sk_d.
 *
 * M_point = C2 - sk_d*C1 = g^m
 * Then brute-force discrete log over small candidate space to recover value.
 */
function decrypt(C1bytes, C2bytes, skD, candidates = range(1, 200)) {
  const C1pt = decompressPoint(C1bytes);
  const C2pt = decompressPoint(C2bytes);

  // M_point = C2 - skD*C1   (= g^m)
  const skDC1 = C1pt.mul(skD);
  const negSkDC1 = skDC1.neg();
  const Mpoint = C2pt.add(negSkDC1);

  const MCompressed = compressPoint(Mpoint).toString("hex");

  for (const v of candidates) {
    const m = valueToScalar(v);
    const Gm = G.mul(m);
    if (compressPoint(Gm).toString("hex") === MCompressed) return v;
  }

  return null; // not found in search space
}

module.exports = { decrypt };

