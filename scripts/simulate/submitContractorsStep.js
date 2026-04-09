const { C, ok, fail, info, bold } = require("./ansi");
const { findEventByName } = require("./eventUtils");

module.exports = async function submitContractorsStep({
  contract,
  taskId,
  contractorSigners,
  contractorData,
  clientKeys,
  generateKeyPair,
  encrypt,
  generateProof,
  verifyProof,
}) {
  const submissionResults = [];

  for (let i = 0; i < contractorData.length; i++) {
    const { label, value, correct } = contractorData[i];
    const signer = contractorSigners[i];

    console.log(
      `\n  ${C.yellow}${label}${C.reset} → result = ${bold(
        String(value)
      )} (${correct ? C.green + "correct" : C.red + "wrong"}${C.reset})`
    );

    // Generate contractor keypair
    const conKeys = generateKeyPair();

    // Encrypt the result
    const cipher = encrypt(value, clientKeys.pk);
    info(`  C1 (g^r): ${cipher.C1.toString("hex").slice(0, 20)}…`);
    info(`  C2 (encrypted payload): ${cipher.C2.toString("hex").slice(0, 20)}…`);
    info(`  C3 (equality base): ${cipher.C3.toString("hex").slice(0, 20)}…`);
    info(`  C4 (equality commitment): ${cipher.C4.toString("hex").slice(0, 20)}…`);

    // Generate DLEQ proof
    const proof = generateProof(cipher, conKeys.pkBytes);
    info(`  A1: ${proof.A1.toString("hex").slice(0, 20)}…`);
    info(`  A4: ${proof.A4.toString("hex").slice(0, 20)}…`);
    info(`  zr: ${proof.zr.toString("hex").slice(0, 20)}…`);

    // Off-chain verify (sanity check)
    const offChainOk = verifyProof(
      { C1: cipher.C1, C3: cipher.C3, C4: cipher.C4, A1: proof.A1, A4: proof.A4, zr: proof.zr },
      conKeys.pkBytes
    );
    if (offChainOk) ok(`  Off-chain proof valid ✓`);
    else fail(`  Off-chain proof INVALID`);

    // Submit to contract
    const tx = await contract
      .connect(signer)
      .submitResult(
        taskId,
        cipher.C1,
        cipher.C2,
        cipher.C3,
        cipher.C4,
        proof.A1,
        proof.A4,
        proof.zr,
        conKeys.pkBytes
      );
    const receipt = await tx.wait();

    // Parse ResultSubmitted event
    const evt = findEventByName(contract, receipt.logs, "ResultSubmitted");
    const onChainValid = evt ? evt.args.proofValid : false;
    if (onChainValid) ok(`  On-chain proof accepted ✓`);
    else fail(`  On-chain proof REJECTED ✗`);

    submissionResults.push({ label, value, correct, onChainValid, signer });
  }

  return { submissionResults };
};

