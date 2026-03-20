const { createHash, randomBytes } = require("crypto");
const { BN } = require("bn.js");

const { N } = require("./ecc");

/** Random scalar in [1, N-1]. */
function randomScalar() {
  // Keep sampling until we get a scalar in range.
  while (true) {
    const buf = randomBytes(32);
    const n = new BN(buf.toString("hex"), 16);
    if (n.gtn(0) && n.lt(N)) return n;
  }
}

/** Hash bytes (concat of parts) -> scalar (mod N). */
function hashToScalar(...parts) {
  const data = Buffer.concat(
    parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p)))
  );
  const digest = createHash("sha256").update(data).digest("hex");
  return new BN(digest, 16).umod(N);
}

/** Convert a result value (e.g., 25) to scalar m = H(value) mod N. */
function valueToScalar(value) {
  return hashToScalar(Buffer.from(String(value)));
}

module.exports = {
  randomScalar,
  hashToScalar,
  valueToScalar,
};

