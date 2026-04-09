const { ec: EC } = require("elliptic");

const ec = new EC("secp256k1");
const G = ec.g; // generator point
const N = ec.n; // curve order (BN)

/** Compress an elliptic point to 33 bytes (SEC1). */
function compressPoint(point) {
  return Buffer.from(point.encode("array", true)); // prefix 02/03 + 32-byte x
}

/** Encode an elliptic point as 64 bytes: x(32) || y(32). */
function encodePointXY(point) {
  const x = point.getX().toArrayLike(Buffer, "be", 32);
  const y = point.getY().toArrayLike(Buffer, "be", 32);
  return Buffer.concat([x, y]);
}

/** Decompress 33 bytes to an elliptic point. */
function decompressPoint(buf) {
  return ec.keyFromPublic(buf).getPublic();
}

module.exports = {
  ec,
  G,
  N,
  compressPoint,
  encodePointXY,
  decompressPoint,
};

