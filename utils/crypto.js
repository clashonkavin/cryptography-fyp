/**
 * crypto.js  –  Pairing-free PKEET-LE inspired crypto utilities
 *
 * Scheme (secp256k1):
 *   KeyGen:  sk = x (scalar), pk = g^x (point)
 *   Encrypt: C1 = g^r,  C2 = M_point + r*pk_d,  C4 = g^m + H1(m)*h
 *   Proof:   Schnorr PoK of r:  (R=g^k, z=k+e*r)  where e=H(R||C1||C2||C4||pk_e)
 *   Decrypt: M_point = C2 - sk_d*C1
 */

const { ec: EC } = require("elliptic");
const { createHash } = require("crypto");
const { ethers } = require("ethers");

const ec = new EC("secp256k1");
const G = ec.g;                         // generator
const N = ec.n;                         // curve order (BN)

// ── Second generator h = hash_to_curve("h") ──────────────────────────────────
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

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Random scalar in [1, N-1] */
function randomScalar() {
  const { BN } = require("bn.js");
  while (true) {
    const buf = require("crypto").randomBytes(32);
    const n = new BN(buf.toString("hex"), 16);
    if (n.gtn(0) && n.lt(N)) return n;
  }
}

/** Hash bytes → scalar (mod N) */
function hashToScalar(...parts) {
  const { BN } = require("bn.js");
  const data = Buffer.concat(
    parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p)))
  );
  const digest = createHash("sha256").update(data).digest("hex");
  return new BN(digest, 16).umod(N);
}

/** Compress an elliptic point to 33 bytes */
function compressPoint(point) {
  return Buffer.from(point.encode("array", true)); // prefix 02/03 + 32-byte x
}

/** Decompress 33 bytes to an elliptic point */
function decompressPoint(buf) {
  return ec.keyFromPublic(buf).getPublic();
}

/** Convert a result value (e.g., 25) to a curve point M = g^hash(value) */
function valueToPoint(value) {
  const { BN } = require("bn.js");
  const m = hashToScalar(Buffer.from(String(value)));
  return G.mul(m);
}

/** scalar from value (same deterministic mapping) */
function valueToScalar(value) {
  return hashToScalar(Buffer.from(String(value)));
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Key Generation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate a keypair.
 * @returns {{ sk: BN, pk: Point, pkBytes: Buffer }}
 */
function generateKeyPair() {
  const sk = randomScalar();
  const pk = G.mul(sk);
  return { sk, pk, pkBytes: compressPoint(pk) };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Encryption
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Encrypt a numeric result for the client's public key.
 *
 * @param {number|string} result   - The computation result (e.g. 25)
 * @param {Point}         pkD      - Client's public key point
 * @returns {{ C1, C2, C4, r, m }} - All compressed as Buffers; r,m are BN scalars
 */
function encrypt(result, pkD) {
  const r = randomScalar();
  const m = valueToScalar(result);   // m = H(result) mod N

  // C1 = g^r
  const C1 = G.mul(r);

  // C2 = g^m + r*pk_d    (map result to a point, then mask with client key)
  const Gm   = G.mul(m);
  const rPkD = pkD.mul(r);
  const C2   = Gm.add(rPkD);

  // C4 = g^m + H1(m)*h   (equality tag – same m → same C4)
  const mBuf  = Buffer.from(m.toString(16, 64), "hex");
  const h1m   = hashToScalar(mBuf);        // H1(m) scalar
  const GmC4  = G.mul(m);
  const h1mH  = H_POINT.mul(h1m);
  const C4    = GmC4.add(h1mH);

  return {
    C1:     compressPoint(C1),
    C2:     compressPoint(C2),
    C4:     compressPoint(C4),
    r,      // keep for proof generation
    m,      // keep for reference
    rScalar: r,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Proof Generation  (Schnorr PoK of r)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate Schnorr proof: prove knowledge of r s.t. C1 = g^r
 *
 *   k  ← random
 *   R  = g^k
 *   e  = H(R || C1 || C2 || C4 || pkE) mod N
 *   z  = k + e*r mod N
 *
 * @returns {{ R: Buffer, z: Buffer }}  – both compressed/padded
 */
function generateProof({ C1, C2, C4, r }, pkE) {
  const k = randomScalar();
  const R = G.mul(k);
  const Rbuf = compressPoint(R);

  // Challenge
  const e = hashToScalar(Rbuf, C1, C2, C4, pkE);

  // Response z = k + e*r mod N
  const z = k.add(e.mul(r)).umod(N);

  // Pad z to 32 bytes
  const zBuf = Buffer.from(z.toString(16, 64), "hex");

  return { R: Rbuf, z: zBuf };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Proof Verification  (off-chain mirror of on-chain logic)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Verify Schnorr proof off-chain.
 * Check: g^z == R + e*C1
 */
function verifyProof({ C1, C2, C4, R, z }, pkEBytes) {
  const { BN } = require("bn.js");

  const zBN  = new BN(z.toString("hex"), 16);
  const C1pt = decompressPoint(C1);
  const Rpt  = decompressPoint(R);

  const e = hashToScalar(R, C1, C2, C4, pkEBytes);

  const lhs = G.mul(zBN);           // g^z
  const rhs = Rpt.add(C1pt.mul(e)); // R + e*C1

  return lhs.eq(rhs);
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Decryption
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Decrypt ciphertext (C1, C2) with client's secret key sk_d.
 *
 *   M_point = C2 - sk_d * C1
 *
 * Then brute-force the discrete log over small result space to recover value.
 *
 * @param {Buffer}        C1bytes
 * @param {Buffer}        C2bytes
 * @param {BN}            skD       - client secret key
 * @param {Array<number>} candidates - small search space (e.g. [1..100])
 * @returns {number|null}
 */
function decrypt(C1bytes, C2bytes, skD, candidates = range(1, 200)) {
  const C1pt = decompressPoint(C1bytes);
  const C2pt = decompressPoint(C2bytes);

  // M_point = C2 - skD*C1   (=  g^m + r*pkD - skD*g^r = g^m)
  const skDC1   = C1pt.mul(skD);
  const negSkDC1 = skDC1.neg();
  const Mpoint  = C2pt.add(negSkDC1);

  const MCompressed = compressPoint(Mpoint).toString("hex");

  // Search over candidates
  for (const v of candidates) {
    const m  = valueToScalar(v);
    const Gm = G.mul(m);
    if (compressPoint(Gm).toString("hex") === MCompressed) {
      return v;
    }
  }
  return null; // not found in search space
}

function range(from, to) {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  generateKeyPair,
  encrypt,
  generateProof,
  verifyProof,
  decrypt,
  compressPoint,
  decompressPoint,
  valueToScalar,
  hashToScalar,
  H_POINT,
  G,
  N,
};
