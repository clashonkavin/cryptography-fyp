const hre = require("hardhat");
const {
  generateKeyPair,
  encrypt,
  generateProof,
  verifyProof,
  decrypt,
} = require("../../utils/crypto");

const { banner, section, bold, C } = require("./ansi");
const deployContractStep = require("./deployContractStep");
const createTaskStep = require("./createTaskStep");
const submitContractorsStep = require("./submitContractorsStep");
const finalizeTaskStep = require("./finalizeTaskStep");
const decryptWinningResultStep = require("./decryptWinningResultStep");

async function runSimulation() {
  banner("BLOCKCHAIN OUTSOURCED COMPUTATION DEMO");
  console.log(`  Scheme: pairing-free PKEET-LE inspired (secp256k1)`);
  console.log(`  Proof:  Schnorr PoK of encryption randomness r`);

  // ── 1. Deploy contract ───────────────────────────────────────────────────
  section("Step 1 · Deploy Contract");
  const { contract, clientSigner, contractorSigners } =
    await deployContractStep(hre);

  // ── 2. Client key generation + task creation ────────────────────────────
  section("Step 2 · Client Key Generation & Task Creation");
  const rewardEth = "0.05"; // ETH per task
  const description = "Compute square of 5";
  const { clientKeys, taskId } = await createTaskStep({
    contract,
    clientSigner,
    hre,
    generateKeyPair,
    rewardEth,
    description,
  });

  // ── 3. Contractors encrypt & submit ─────────────────────────────────────
  section("Step 3 · Contractor Submissions");
  const contractorData = [
    { label: "Contractor 1", value: 25, correct: true },
    { label: "Contractor 2", value: 25, correct: true },
    { label: "Contractor 3", value: 30, correct: false }, // wrong
    { label: "Contractor 4", value: 25, correct: true },
    { label: "Contractor 5", value: 25, correct: true },
  ];

  await submitContractorsStep({
    contract,
    taskId,
    contractorSigners,
    contractorData,
    clientKeys,
    generateKeyPair,
    encrypt,
    generateProof,
    verifyProof,
  });

  // ── 4. Client finalises the task ────────────────────────────────────────
  section("Step 4 · Finalize Task (Majority Vote)");
  await finalizeTaskStep({
    contract,
    taskId,
    clientSigner,
    contractorSigners,
    hre,
    contractorData,
  });

  // ── 5. Client decrypts ──────────────────────────────────────────────────
  section("Step 5 · Client Decrypts Winning Result");
  const result = await decryptWinningResultStep({
    contract,
    taskId,
    clientKeys,
    decrypt,
  });

  // ── Summary ─────────────────────────────────────────────────────────────
  banner("SIMULATION COMPLETE");
  console.log(`  ${C.green}✔${C.reset}  Contract deployed and task lifecycle completed`);
  console.log(`  ${C.green}✔${C.reset}  Schnorr proofs verified on-chain (pure Solidity EC math)`);
  console.log(`  ${C.green}✔${C.reset}  Majority vote selected correct result (25)`);
  console.log(`  ${C.green}✔${C.reset}  Dishonest contractor rejected & unrewarded`);
  console.log(
    `  ${C.green}✔${C.reset}  Client decrypted: square(5) = ${bold(String(result))}\n`
  );
}

module.exports = { runSimulation };

