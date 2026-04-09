const { BN } = require("bn.js");
const crypto = require("node:crypto");

// BN254 / altbn128 base field prime and scalar field order (same as EVM precompile curve).
const P = new BN(
  "21888242871839275222246405745257275088696311157297823662689037894645226208583",
  10
);
const R = new BN(
  "21888242871839275222246405745257275088548364400416034343698204186575808495617",
  10
);

// Curve: y^2 = x^3 + 3 over Fp
const B = new BN(3);

function mod(a) {
  const x = a.umod(P);
  return x.isNeg() ? x.add(P) : x;
}

function inv(a) {
  // a^(p-2) mod p
  return a.toRed(BN.red(P)).redPow(P.subn(2)).fromRed();
}

function isInfinity(pt) {
  return pt.z.isZero();
}

function toJacobian(pt) {
  return { x: pt.x, y: pt.y, z: new BN(1) };
}

function fromJacobian(pj) {
  if (pj.z.isZero()) return { x: new BN(0), y: new BN(0), z: new BN(0) };
  const zInv = inv(pj.z);
  const zInv2 = mod(zInv.mul(zInv));
  const zInv3 = mod(zInv2.mul(zInv));
  return {
    x: mod(pj.x.mul(zInv2)),
    y: mod(pj.y.mul(zInv3)),
    z: new BN(1),
  };
}

function jacobianDouble(p1) {
  if (p1.z.isZero() || p1.y.isZero()) return { x: new BN(0), y: new BN(0), z: new BN(0) };

  const XX = mod(p1.x.mul(p1.x));
  const YY = mod(p1.y.mul(p1.y));
  const YYYY = mod(YY.mul(YY));
  const S = mod(new BN(4).mul(p1.x).mul(YY));
  const M = mod(new BN(3).mul(XX)); // a=0

  const X3 = mod(M.mul(M).sub(S.muln(2)));
  const Y3 = mod(M.mul(S.sub(X3)).sub(YYYY.muln(8)));
  const Z3 = mod(p1.y.mul(p1.z).muln(2));
  return { x: X3, y: Y3, z: Z3 };
}

function jacobianAdd(p1, p2) {
  if (p1.z.isZero()) return p2;
  if (p2.z.isZero()) return p1;

  const Z1Z1 = mod(p1.z.mul(p1.z));
  const Z2Z2 = mod(p2.z.mul(p2.z));
  const U1 = mod(p1.x.mul(Z2Z2));
  const U2 = mod(p2.x.mul(Z1Z1));
  const S1 = mod(p1.y.mul(p2.z).mul(Z2Z2));
  const S2 = mod(p2.y.mul(p1.z).mul(Z1Z1));

  if (U1.eq(U2)) {
    if (S1.eq(S2)) return jacobianDouble(p1);
    return { x: new BN(0), y: new BN(0), z: new BN(0) };
  }

  const H = mod(U2.sub(U1));
  const HH = mod(H.mul(H));
  const HHH = mod(H.mul(HH));
  const RR = mod(S2.sub(S1));
  const V = mod(U1.mul(HH));

  const X3 = mod(RR.mul(RR).sub(HHH).sub(V.muln(2)));
  const Y3 = mod(RR.mul(V.sub(X3)).sub(S1.mul(HHH)));
  const Z3 = mod(H.mul(p1.z).mul(p2.z));
  return { x: X3, y: Y3, z: Z3 };
}

function mulG1(scalar) {
  return mulPoint({ x: new BN(1), y: new BN(2), z: new BN(1) }, scalar);
}

function mulPoint(basePoint, scalar) {
  let k = new BN(scalar).umod(R);
  if (k.isZero()) return { x: new BN(0), y: new BN(0), z: new BN(0) };

  let Q = { x: new BN(0), y: new BN(0), z: new BN(0) };
  let A = { x: new BN(basePoint.x), y: new BN(basePoint.y), z: new BN(1) };

  while (!k.isZero()) {
    if (k.andln(1) === 1) Q = jacobianAdd(Q, A);
    A = jacobianDouble(A);
    k = k.shrn(1);
  }
  return fromJacobian(Q);
}

function addPoints(p1, p2) {
  return fromJacobian(jacobianAdd(toJacobian(p1), toJacobian(p2)));
}

function hashToScalar(...parts) {
  const data = Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))));
  const digest = crypto.createHash("sha256").update(data).digest();
  return new BN(digest.toString("hex"), 16).umod(R);
}

function keccak256(buf) {
  // node crypto doesn't have keccak; ethers does, but keep dependencies minimal:
  // use sha256 for deterministic demo hashing to match contract's keccak? No.
  // We'll compute keccak256 via ethers when available by requiring it lazily.
  const { keccak256: k, getBytes } = require("ethers");
  return Buffer.from(getBytes(k(buf)));
}

function deriveScalarForOldScheme({ C1, C2, C3, zBytes, pkE }) {
  // Must match Solidity: keccak256("OLD_PKEET_LE" || C1 || C2 || C3 || zBytes || pkE) % r
  const tag = Buffer.from("OLD_PKEET_LE", "utf8");
  const digest = keccak256(Buffer.concat([tag, C1, C2, C3, zBytes, pkE]));
  return new BN(digest.toString("hex"), 16).umod(R);
}

function g1ToUncompressed64(pt) {
  const x = pt.x.toArrayLike(Buffer, "be", 32);
  const y = pt.y.toArrayLike(Buffer, "be", 32);
  return Buffer.concat([x, y]);
}

function randomScalar32() {
  const b = crypto.randomBytes(32);
  return new BN(b.toString("hex"), 16).umod(R).toArrayLike(Buffer, "be", 32);
}

function randomScalarBN() {
  return new BN(randomScalar32().toString("hex"), 16).umod(R);
}

function buildPairingFreeSubmission(value, pkEBytes64) {
  const m = hashToScalar(Buffer.from(String(value)));
  const r = randomScalarBN();
  const k = randomScalarBN();

  const G = { x: new BN(1), y: new BN(2), z: new BN(1) };
  const C1 = mulPoint(G, r);
  const C3 = mulPoint(G, m);
  const C4 = mulPoint(C3, r);
  const A1 = mulPoint(G, k);
  const A4 = mulPoint(C3, k);

  const C1b = g1ToUncompressed64(C1);
  const C3b = g1ToUncompressed64(C3);
  const C4b = g1ToUncompressed64(C4);
  const A1b = g1ToUncompressed64(A1);
  const A4b = g1ToUncompressed64(A4);
  const e = hashToScalar(A1b, A4b, C1b, C3b, C4b, pkEBytes64);
  const zr = k.add(e.mul(r)).umod(R).toArrayLike(Buffer, "be", 32);

  return { C1: C1b, C3: C3b, C4: C4b, A1: A1b, A4: A4b, zr };
}

module.exports = {
  P,
  R,
  mulG1,
  mulPoint,
  addPoints,
  hashToScalar,
  deriveScalarForOldScheme,
  g1ToUncompressed64,
  randomScalar32,
  randomScalarBN,
  buildPairingFreeSubmission,
};

