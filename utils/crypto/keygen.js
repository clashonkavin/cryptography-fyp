const { G, compressPoint } = require("./ecc");
const { randomScalar } = require("./scalars");

/**
 * Generate a keypair.
 * @returns {{ sk: BN, pk: Point, pkBytes: Buffer }}
 */
function generateKeyPair() {
  const sk = randomScalar();
  const pk = G.mul(sk);
  return { sk, pk, pkBytes: compressPoint(pk) };
}

module.exports = { generateKeyPair };

