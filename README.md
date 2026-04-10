# Blockchain Outsourced Computation Demo

This repository demonstrates a verifiable outsourced-computation workflow with two on-chain schemes:

- `OutsourcedComputation` (**new scheme**): pairing-free verification using BN254 `ECADD`/`ECMUL` precompiles.
- `OutsourcedComputationPairing` (**old scheme baseline**): pairing-based verification using BN254 pairing precompile.

The current implementation is tuned so the new pairing-free path is cheaper in gas than the pairing baseline while keeping end-to-end correctness (submit, finalize, decrypt).

---

## What Changed (Latest)

### 1) Pairing-free verifier migrated to BN254 precompiles

`contracts/lib/DLEQVerifier.sol` now verifies DLEQ with:

- precompile `0x07` (`ECMUL`)
- precompile `0x06` (`ECADD`)

No pairing is used in the new scheme verifier.

### 2) Pairing baseline verification fixed and made real

`contracts/OutsourcedComputationPairing.sol`:

- now performs real pairing checks (not a stub)
- includes corrected point negation over BN254 base field
- remains intentionally heavier than the new scheme for comparison

### 3) Decryption path fixed after proof migration

New scheme submission now carries two `C1` values:

- `C1Proof` (64-byte BN254 point) for on-chain proof verification
- `C1Decrypt` (33-byte compressed secp256k1 point) for off-chain decryption

Contract stores `C1Decrypt` as the winning `C1`, so decryption works with existing secp decrypt logic.

### 4) Simulation/API robustness fixes

- task id resolution now has safe fallbacks (receipt parse -> queryFilter -> `taskCount`)
- deploy/create/submit now use signers from the same provider context to avoid network mismatch issues

---

## High-Level Flow

1. Client creates task and deposits reward
2. Contractors submit encrypted result + proof
3. Contract verifies proof, stores submission
4. Client finalizes task (majority by equality tag)
5. Winners are paid
6. Client decrypts winning ciphertext off-chain

---

## Contracts

- `contracts/OutsourcedComputation.sol`
  - new pairing-free scheme
  - accepts:
    - `C1Proof` (BN254, 64 bytes)
    - `C1Decrypt` (secp256k1 compressed, 33 bytes)
    - `C2`, `C3`, `C4`, `A1`, `A4`, `zrBytes`, `pkE`
  - verifies DLEQ using BN254 EC precompiles via `DLEQVerifier`
  - finalization groups by `C3`
  - winning ciphertext returns decryptable secp `C1Decrypt` + `C2`

- `contracts/OutsourcedComputationPairing.sol`
  - old pairing-based comparison baseline
  - uses pairing precompile in verification path

---

## Run

### Prerequisites

- Node.js 18+
- npm

### Install

```bash
npm install
```

### Compile

```bash
npm run compile
```

### Start UI/API

```bash
npm start
```

Then open `http://127.0.0.1:3000`.

UI now includes a **Research Dashboard (M1-M6)** section with charts/KPIs and a one-click
`Run Research Benchmarks` action for screenshot-ready outputs.

UI also includes **Step 0: NP Verifier Program**:

- choose a built-in verifier (`subset_sum`, `three_sat`, `hamiltonian_cycle`)
- or provide custom JavaScript verifier code
- submit `instance` and `witness` JSON using int/float/array/object values
- receive validity result + runtime in milliseconds
- optional toggle to attach verifier policy to task creation
- optional enforcement mode: skip contractor submissions whose witness fails verification

This verifier attachment is optional by design (useful for NP-style checks, but can be disabled for tasks
that do not admit polynomial-time verification).

### CLI simulation

```bash
npm run simulate
```

### Multi-scenario gas benchmark (with visual report)

Run a deterministic benchmark suite that compares pairing-free (new) vs pairing-based (old)
across several contractor distributions, then auto-generates machine + human-readable reports:

```bash
npm run benchmark:gas
```

Outputs are written under:

- `reports/benchmarks/<timestamp>/benchmark-results.json`
- `reports/benchmarks/<timestamp>/benchmark-report.md`
- `reports/benchmarks/<timestamp>/benchmark-report.html`

The script enforces that the pairing-free scheme remains cheaper by at least a threshold
(default: `5%` improvement). To change the threshold:

```bash
MIN_IMPROVEMENT_PERCENT=8 npm run benchmark:gas
```

Default scenarios live in `scripts/benchmark/scenarios.json`. You can point to a custom
scenario file:

```bash
BENCHMARK_SCENARIOS_FILE=./my-scenarios.json npm run benchmark:gas
```

### Research benchmark suite (M1-M6, paper-ready output)

Runs explicit metrics and generates a screenshot-friendly report:

```bash
npm run benchmark:research
```

Outputs are written under:

- `reports/research/<timestamp>/research-benchmark.json`
- `reports/research/<timestamp>/research-benchmark.html`

Included metrics:

- `M1` Gas cost per verification vs pairing baseline across `n = 1,5,10,20,50`
- `M2` Off-chain proof generation time (Node.js; noble-secp256k1-assisted benchmark)
- `M3` Ciphertext size comparison in bytes
- `M4` EqTest latency and estimated single-call gas
- `M5` Adversarial tests (copy, C3 forgery, malformed r-response)
- `M6` Scalability with linear fit (R²) for submit gas growth

---

## Current Gas Comparison (Example Run)

From the latest local run:

- `newScheme.totalGas`: `5,707,245`
- `oldScheme.totalGas`: `6,502,486`
- `deltaGas`: `795,241`
- `ratioOldToNew`: `1.1393x`

Example first submission:

- new scheme: `675,956` gas
- old scheme: `871,739` gas

Results vary slightly by run/environment, but direction should remain:
**new pairing-free scheme < old pairing scheme**.

---

## Notes

- Decryption is off-chain and currently brute-forces candidate values in a small range.
- This is a research/demo codebase, not production-hardened cryptography.
- If you run into stale ABI/runtime issues in the UI, restart the server after code changes.
- API/server contractor capacity is configurable via `MAX_CONTRACTORS` (default `100`).
  Extra contractor wallets are auto-created/funded on local Hardhat when needed.
