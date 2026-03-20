const { G, compressPoint } = require("./ecc");
const { randomScalar, valueToScalar, hashToScalar } = require("./scalars");
const { H_POINT } = require("./generators");

/**
 * Encrypt a numeric result for the client's public key.
 *
 * @param {number|string} result  - The computation result (e.g. 25)
 * @param {Point}         pkD     - Client's public key point
 * @returns {{ C1, C2, C4, r, m }} - All compressed as Buffers; r,m are BN scalars
 */
function encrypt(result, pkD) {
  const r = randomScalar();
  const m = valueToScalar(result); // m = H(result) mod N

  // C1 = g^r
  const C1 = G.mul(r);

  // C2 = g^m + r*pk_d  (map result to a point, then mask with client key)
  const Gm = G.mul(m);
  const rPkD = pkD.mul(r);
  const C2 = Gm.add(rPkD);

  // C4 = g^m + H1(m)*h  (equality tag – same m -> same C4)
  const mBuf = Buffer.from(m.toString(16, 64), "hex");
  const h1m = hashToScalar(mBuf); // H1(m) scalar
  const GmC4 = G.mul(m);
  const h1mH = H_POINT.mul(h1m);
  const C4 = GmC4.add(h1mH);

  return {
    C1: compressPoint(C1),
    C2: compressPoint(C2),
    C4: compressPoint(C4),
    r, // keep for proof generation
    m, // keep for reference
    rScalar: r,
  };
}

module.exports = { encrypt };

