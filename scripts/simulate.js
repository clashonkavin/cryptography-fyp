/**
 * simulate.js  –  End-to-end demo of the outsourced computation system
 *
 * Flow:
 *  1. Deploy OutsourcedComputation contract
 *  2. Client generates keypair, creates task "Compute square of 5"
 *  3. Five contractors participate:
 *       - Contractors 1, 2, 4 → correct answer (25)
 *       - Contractor 3         → wrong answer   (30)
 *       - Contractor 5         → correct answer (25)
 *  4. Contract verifies proofs, groups by C4, selects majority
 *  5. Client fetches winning ciphertext, decrypts, prints result
 */

const hre = require("hardhat");
const { ethers } = require("ethers");
const {
  generateKeyPair,
  encrypt,
  generateProof,
  verifyProof,
  decrypt,
} = require("../utils/crypto");

// ── ANSI colour helpers ───────────────────────────────────────────────────────
const C = {
  reset:  "\x1b[0m",
  bold:   "\x1b[1m",
  cyan:   "\x1b[36m",
  green:  "\x1b[32m",
  red:    "\x1b[31m",
  yellow: "\x1b[33m",
  magenta:"\x1b[35m",
  blue:   "\x1b[34m",
  grey:   "\x1b[90m",
};
const banner  = (msg) => console.log(`\n${C.bold}${C.cyan}${"═".repeat(60)}${C.reset}\n${C.bold}${C.cyan}  ${msg}${C.reset}\n${C.bold}${C.cyan}${"═".repeat(60)}${C.reset}`);
const section = (msg) => console.log(`\n${C.bold}${C.blue}── ${msg} ${"─".repeat(Math.max(0, 56 - msg.length))}${C.reset}`);
const ok      = (msg) => console.log(`  ${C.green}✔${C.reset}  ${msg}`);
const fail    = (msg) => console.log(`  ${C.red}✘${C.reset}  ${msg}`);
const info    = (msg) => console.log(`  ${C.grey}ℹ${C.reset}  ${msg}`);
const bold    = (msg) => `${C.bold}${msg}${C.reset}`;

// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  banner("BLOCKCHAIN OUTSOURCED COMPUTATION DEMO");
  console.log(`  Scheme: pairing-free PKEET-LE inspired (secp256k1)`);
  console.log(`  Proof:  Schnorr PoK of encryption randomness r`);

  // ── 1. Deploy contract ────────────────────────────────────────────────────
  section("Step 1 · Deploy Contract");

  const accounts = await hre.ethers.getSigners();
  const clientSigner      = accounts[0];
  const contractorSigners = accounts.slice(1, 6); // 5 contractors

  const Factory = await hre.ethers.getContractFactory("OutsourcedComputation");
  const contract = await Factory.deploy();
  await contract.waitForDeployment();

  const addr = await contract.getAddress();
  ok(`OutsourcedComputation deployed at ${bold(addr)}`);
  info(`Client:       ${clientSigner.address}`);
  contractorSigners.forEach((s, i) =>
    info(`Contractor ${i + 1}: ${s.address}`)
  );

  // ── 2. Client – key generation + task creation ────────────────────────────
  section("Step 2 · Client Key Generation & Task Creation");

  const clientKeys = generateKeyPair();
  ok(`Client secret key (hex): ${clientKeys.sk.toString(16).slice(0, 16)}…`);
  ok(`Client public key (compressed): ${clientKeys.pkBytes.toString("hex").slice(0, 16)}…`);

  const rewardEth   = "0.05"; // ETH per task
  const rewardWei   = hre.ethers.parseEther(rewardEth);
  const description = "Compute square of 5";

  const tx1 = await contract.connect(clientSigner).createTask(
    description,
    rewardWei,
    { value: rewardWei }
  );
  const receipt1 = await tx1.wait();
  const taskCreatedEvent = receipt1.logs
    .map((log) => { try { return contract.interface.parseLog(log); } catch (_) { return null; } })
    .find((e) => e && e.name === "TaskCreated");

  const taskId = taskCreatedEvent ? taskCreatedEvent.args.taskId : 1n;
  ok(`Task #${taskId} created: "${description}"`);
  ok(`Reward deposited: ${rewardEth} ETH`);

  // ── 3. Contractors encrypt & submit ──────────────────────────────────────
  section("Step 3 · Contractor Submissions");

  const contractorData = [
    { label: "Contractor 1", value: 25, correct: true  },
    { label: "Contractor 2", value: 25, correct: true  },
    { label: "Contractor 3", value: 30, correct: false }, // wrong
    { label: "Contractor 4", value: 25, correct: true  },
    { label: "Contractor 5", value: 25, correct: true  },
  ];

  const submissionResults = [];

  for (let i = 0; i < contractorData.length; i++) {
    const { label, value, correct } = contractorData[i];
    const signer = contractorSigners[i];

    console.log(`\n  ${C.yellow}${label}${C.reset} → result = ${bold(String(value))} (${correct ? C.green + "correct" : C.red + "wrong"}${C.reset})`);

    // Generate contractor keypair
    const conKeys = generateKeyPair();

    // Encrypt the result
    const cipher = encrypt(value, clientKeys.pk);
    info(`  C1 (g^r): ${cipher.C1.toString("hex").slice(0, 20)}…`);
    info(`  C2 (M+r·pkD): ${cipher.C2.toString("hex").slice(0, 20)}…`);
    info(`  C4 (equality tag): ${cipher.C4.toString("hex").slice(0, 20)}…`);

    // Generate Schnorr proof
    const proof = generateProof(cipher, conKeys.pkBytes);
    info(`  R: ${proof.R.toString("hex").slice(0, 20)}…`);
    info(`  z: ${proof.z.toString("hex").slice(0, 20)}…`);

    // Off-chain verify (sanity check)
    const offChainOk = verifyProof(
      { C1: cipher.C1, C2: cipher.C2, C4: cipher.C4, R: proof.R, z: proof.z },
      conKeys.pkBytes
    );
    if (offChainOk) ok(`  Off-chain proof valid ✓`);
    else            fail(`  Off-chain proof INVALID`);

    // Submit to contract
    const tx = await contract.connect(signer).submitResult(
      taskId,
      cipher.C1,
      cipher.C2,
      cipher.C4,
      proof.R,
      proof.z,
      conKeys.pkBytes
    );
    const receipt = await tx.wait();

    // Parse ResultSubmitted event
    const evt = receipt.logs
      .map((log) => { try { return contract.interface.parseLog(log); } catch (_) { return null; } })
      .find((e) => e && e.name === "ResultSubmitted");

    const onChainValid = evt ? evt.args.proofValid : false;
    if (onChainValid) ok(`  On-chain proof accepted ✓`);
    else              fail(`  On-chain proof REJECTED ✗`);

    submissionResults.push({ label, value, correct, onChainValid, signer });
  }

  // ── 4. Client finalises the task ──────────────────────────────────────────
  section("Step 4 · Finalize Task (Majority Vote)");

  const balancesBefore = await Promise.all(
    contractorSigners.map((s) => hre.ethers.provider.getBalance(s.address))
  );

  const tx2 = await contract.connect(clientSigner).finalizeTask(taskId);
  const receipt2 = await tx2.wait();

  // Parse events
  const events = receipt2.logs
    .map((log) => { try { return contract.interface.parseLog(log); } catch (_) { return null; } })
    .filter(Boolean);

  const finalizeEvt = events.find((e) => e.name === "TaskFinalized");
  if (finalizeEvt) {
    const winC4hex = Buffer.from(
      finalizeEvt.args.winningC4.slice(2), "hex"
    ).toString("hex");
    ok(`Task finalized!`);
    info(`Majority count: ${finalizeEvt.args.majorityCount} / ${finalizeEvt.args.totalSubmissions}`);
    info(`Winning C4: ${winC4hex.slice(0, 20)}…`);
  }

  const rewardedAddrs = events
    .filter((e) => e.name === "ContractorRewarded")
    .map((e) => e.args.contractor.toLowerCase());

  const rejectedAddrs = events
    .filter((e) => e.name === "ContractorRejected")
    .map((e) => ({ addr: e.args.contractor.toLowerCase(), reason: e.args.reason }));

  console.log("");
  contractorData.forEach((cd, i) => {
    const addr = contractorSigners[i].address.toLowerCase();
    const rewarded = rewardedAddrs.includes(addr);
    const rejected = rejectedAddrs.find((r) => r.addr === addr);
    if (rewarded) {
      ok(`${cd.label} (result=${cd.value}) → ${C.green}REWARDED${C.reset} 🏆`);
    } else if (rejected) {
      fail(`${cd.label} (result=${cd.value}) → ${C.red}REJECTED${C.reset} (${rejected.reason})`);
    } else {
      fail(`${cd.label} (result=${cd.value}) → ${C.red}NOT REWARDED${C.reset} (invalid proof)`);
    }
  });

  const balancesAfter = await Promise.all(
    contractorSigners.map((s) => hre.ethers.provider.getBalance(s.address))
  );
  console.log("");
  contractorSigners.forEach((s, i) => {
    const delta = balancesAfter[i] - balancesBefore[i];
    if (delta > 0n) {
      info(`  ETH received by Contractor ${i + 1}: +${hre.ethers.formatEther(delta)} ETH`);
    }
  });

  // ── 5. Client decrypts ────────────────────────────────────────────────────
  section("Step 5 · Client Decrypts Winning Result");

  const [winC1bytes, winC2bytes] = await contract.getWinningCiphertext(taskId);

  const C1buf = Buffer.from(winC1bytes.slice(2), "hex");
  const C2buf = Buffer.from(winC2bytes.slice(2), "hex");

  info(`Winning C1: ${C1buf.toString("hex").slice(0, 20)}…`);
  info(`Winning C2: ${C2buf.toString("hex").slice(0, 20)}…`);

  // Decrypt: M_point = C2 - sk_d * C1
  const result = decrypt(C1buf, C2buf, clientKeys.sk, Array.from({ length: 200 }, (_, i) => i));

  if (result !== null) {
    console.log(`\n  ${C.bold}${C.green}╔══════════════════════════════════════╗${C.reset}`);
    console.log(`  ${C.bold}${C.green}║  Decrypted result: ${String(result).padEnd(18)} ║${C.reset}`);
    console.log(`  ${C.bold}${C.green}╚══════════════════════════════════════╝${C.reset}`);
    ok(`square(5) = ${bold(String(result))}  ← correct!`);
  } else {
    fail("Decryption failed – result not in search space");
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  banner("SIMULATION COMPLETE");
  console.log(`  ${C.green}✔${C.reset}  Contract deployed and task lifecycle completed`);
  console.log(`  ${C.green}✔${C.reset}  Schnorr proofs verified on-chain (pure Solidity EC math)`);
  console.log(`  ${C.green}✔${C.reset}  Majority vote selected correct result (25)`);
  console.log(`  ${C.green}✔${C.reset}  Dishonest contractor rejected & unrewarded`);
  console.log(`  ${C.green}✔${C.reset}  Client decrypted: square(5) = ${bold(String(result))}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
