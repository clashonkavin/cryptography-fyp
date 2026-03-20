# Blockchain Outsourced Computation — Pairing-Free PKEET-LE Demo

A complete working demo of a **verifiable outsourced computation marketplace**
on-chain, combining ElGamal encryption, equality-testing tags, and Schnorr
zero-knowledge proofs — all **pairing-free** on **secp256k1**.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                        SYSTEM OVERVIEW                           │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│   Client                    Smart Contract                       │
│   ──────                    ───────────────                      │
│   1. Generate keypair        OutsourcedComputation.sol           │
│   2. createTask() ────────►  store task + reward (ETH)          │
│                                                                  │
│   Contractor (×N)                                                │
│   ──────────────                                                 │
│   3. Encrypt result                                              │
│   4. Generate Schnorr proof                                      │
│   5. submitResult() ──────►  verify proof on-chain              │
│                              store (C1, C2, C4)                  │
│                                                                  │
│   Client                                                         │
│   6. finalizeTask() ──────►  group by C4 (equality tag)         │
│                              majority vote                       │
│                              pay winning contractors             │
│   7. getWinningCiphertext()                                      │
│   8. Decrypt C2 - sk·C1 = M                                     │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

---

## Cryptographic Scheme

### Keys
| Party      | Secret Key | Public Key |
|------------|-----------|------------|
| Client     | `sk_d = x` | `pk_d = g^x` |
| Contractor | `sk_e = s` | `pk_e = g^s` |

All arithmetic is on **secp256k1** (no pairings).

### Encryption (Contractor → Client)
Given numeric result `v`:

```
m  = SHA256(v) mod N          # map result to scalar
r  ← random scalar

C1 = g^r                       # ElGamal randomness commitment
C2 = g^m + r · pk_d            # encrypted result point
C4 = g^m + H1(m) · h           # equality tag (same v → same C4)
```

`h` is a second generator derived via `hash_to_curve("h")` — fully
deterministic, no trusted setup.

### Schnorr Proof of Knowledge (of `r`)
Proves the contractor knows the `r` used in `C1 = g^r`:

```
k  ← random
R  = g^k
e  = H(R ‖ C1 ‖ C2 ‖ C4 ‖ pk_e)   # Fiat-Shamir challenge
z  = k + e·r  (mod N)

Proof = (R, z)
```

**Verification:** `g^z == R + e·C1`

### Decryption (Client)
```
M_point = C2 − sk_d · C1
        = (g^m + r·pk_d) − sk_d·(g^r)
        = g^m + r·(g^{sk_d}) − sk_d·g^r
        = g^m          ✓
```

Then recover `v` by brute-forcing: find `v` s.t. `g^{H(v)} == M_point`.

---

## On-Chain Verification

`OutsourcedComputation.sol` implements:

1. **`createTask`** — Client deposits ETH reward  
2. **`submitResult`** — Contractor submits `(C1, C2, C4, R, z, pk_e)`; contract runs full Schnorr verification using **pure Solidity secp256k1 EC arithmetic** (double-and-add scalar mul, projective → affine, Fermat inversion)  
3. **`finalizeTask`** — Groups verified submissions by `C4` hash equality, picks majority, distributes ETH  
4. **`getWinningCiphertext`** — Returns `(C1, C2)` for client decryption  

### Equality Testing
Two submissions encrypt the same result if and only if their `C4` tags are identical:

```
C4 = g^m + H1(m)·h
```

Since `m = H(v)` is deterministic, the same `v` always yields the same `C4`,
independent of the random `r`. The smart contract compares `keccak256(C4)` bytes
to group submissions.

---

## File Structure

```
outsourced-computation/
├── contracts/
│   └── OutsourcedComputation.sol   # Full Solidity contract
├── scripts/
│   └── simulate.js                 # End-to-end demo script
├── utils/
│   └── crypto.js                   # JS crypto utilities
├── hardhat.config.js
├── package.json
└── README.md
```

---

## How to Run

### Prerequisites
- Node.js 18+
- npm

### Install
```bash
cd outsourced-computation
npm install
```

### Compile Contract
```bash
npm run compile
```

### Run Simulation
```bash
npm run simulate
```

Expected output:
```
══════════════════════════════════════════════════════════
  BLOCKCHAIN OUTSOURCED COMPUTATION DEMO
══════════════════════════════════════════════════════════

── Step 1 · Deploy Contract ─────────────────────────────
  ✔  OutsourcedComputation deployed at 0x5FbDB...

── Step 2 · Client Key Generation & Task Creation ───────
  ✔  Client secret key (hex): a3f1...
  ✔  Task #1 created: "Compute square of 5"
  ✔  Reward deposited: 0.05 ETH

── Step 3 · Contractor Submissions ──────────────────────

  Contractor 1 → result = 25 (correct)
  ✔  Off-chain proof valid ✓
  ✔  On-chain proof accepted ✓

  Contractor 2 → result = 25 (correct)
  ✔  Off-chain proof valid ✓
  ✔  On-chain proof accepted ✓

  Contractor 3 → result = 30 (wrong)
  ✔  Off-chain proof valid ✓
  ✔  On-chain proof accepted ✓   ← proof is valid, result is just wrong

  ...

── Step 4 · Finalize Task (Majority Vote) ───────────────
  ✔  Task finalized!
  ℹ  Majority count: 4 / 5
  ✔  Contractor 1 (result=25) → REWARDED 🏆
  ✔  Contractor 2 (result=25) → REWARDED 🏆
  ✘  Contractor 3 (result=30) → REJECTED (Minority result)
  ✔  Contractor 4 (result=25) → REWARDED 🏆
  ✔  Contractor 5 (result=25) → REWARDED 🏆

── Step 5 · Client Decrypts Winning Result ──────────────
  ╔══════════════════════════════════════╗
  ║  Decrypted result: 25               ║
  ╚══════════════════════════════════════╝
  ✔  square(5) = 25  ← correct!
```

---

## Security Properties

| Property | How achieved |
|---|---|
| **Confidentiality** | ElGamal encryption under client's public key |
| **Integrity** | Schnorr PoK ensures contractor committed to a valid encryption |
| **Equality testing** | `C4 = g^m + H1(m)·h` — deterministic per result, hides actual value |
| **Non-malleability** | Fiat-Shamir challenge binds `(R, C1, C2, C4, pk_e)` together |
| **Pairing-free** | Pure secp256k1; no bilinear maps required |
| **On-chain verifiable** | Full EC arithmetic implemented in Solidity |

---

## Limitations & Notes

- **Discrete log search space**: Decryption brute-forces `g^{H(v)}` over candidate values — practical for small numeric results (0–200). For large results, use a lookup table or hash-based encoding with a dedicated decrypt circuit.
- **Gas cost**: On-chain EC scalar multiplication is expensive (~1–2M gas per submission verification). In production, use a ZK proof or a signature-based scheme to reduce cost.
- **`allowUnlimitedContractSize`**: Enabled in hardhat config to fit the EC math library. Production deployments should use a precompile or off-chain verification pattern.
