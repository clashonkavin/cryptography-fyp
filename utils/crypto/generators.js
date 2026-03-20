const { createHash } = require("crypto");

const { ec } = require("./ecc");

// ── Second generator h = hash_to_curve("h") ────────────────────────────────
// Deterministic: try successive x values until one is on the curve.
function hashToCurve(tag) {
  for (let i = 0; i < 1000; i++) {
    const x = Buffer.from(
      createHash("sha256").update(`${tag}${i}`).digest("hex"),
      "hex"
    );
    try {
      // attempt to decompress – elliptic will throw if not on curve
      const point = ec.keyFromPublic(
        Buffer.concat([Buffer.from([0x02]), x]),
        "hex"
      ).getPublic();
      if (point.validate()) return point;
    } catch (_) {}
  }
  throw new Error("hashToCurve: exhausted attempts");
}

const H_POINT = hashToCurve("h"); // fixed second generator

module.exports = {
  H_POINT,
  hashToCurve,
};

