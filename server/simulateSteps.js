const crypto = require("node:crypto");
const { ethers } = require("ethers");

const artifact = require("../artifacts/contracts/OutsourcedComputation.sol/OutsourcedComputation.json");
const {
  generateKeyPair,
  encrypt,
  generateProof,
  verifyProof,
  decrypt,
} = require("../utils/crypto");

function parseEvents(contract, logs) {
  return logs
    .map((log) => {
      try {
        return contract.interface.parseLog(log);
      } catch (_) {
        return null;
      }
    })
    .filter(Boolean);
}

function safeGetGasPrice(receipt) {
  return receipt.effectiveGasPrice ?? receipt.gasPrice ?? null;
}

function formatMaybeEther(wei) {
  if (wei === null || wei === undefined) return null;
  return ethers.formatEther(wei);
}

/**
 * Mode of contractor-submitted values with tie-break matching the contract:
 * among largest groups, keep the one whose first occurrence index is smallest.
 */
function pluralityFromValues(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const firstIdx = new Map();
  const counts = new Map();
  for (let i = 0; i < values.length; i++) {
    const v = Number(values[i]);
    if (!counts.has(v)) {
      firstIdx.set(v, i);
      counts.set(v, 0);
    }
    counts.set(v, counts.get(v) + 1);
  }
  let bestV = null;
  let bestC = -1;
  let bestFirst = Infinity;
  for (const [v, c] of counts) {
    const fi = firstIdx.get(v);
    if (c > bestC || (c === bestC && fi < bestFirst)) {
      bestC = c;
      bestV = v;
      bestFirst = fi;
    }
  }
  return { value: bestV, count: bestC };
}

function hexToBuffer(hexOrBytes) {
  if (typeof hexOrBytes === "string") {
    return Buffer.from(hexOrBytes.startsWith("0x") ? hexOrBytes.slice(2) : hexOrBytes, "hex");
  }
  if (hexOrBytes instanceof Uint8Array) return Buffer.from(hexOrBytes);
  if (Buffer.isBuffer(hexOrBytes)) return hexOrBytes;
  if (typeof hexOrBytes === "object" && hexOrBytes !== null && typeof hexOrBytes.toString === "function") {
    return Buffer.from(hexOrBytes.toString("hex"), "hex");
  }
  throw new Error("Unsupported bytes type");
}

async function stepDeploy({ provider, maxContractors = 10 }) {
  const accounts = await provider.listAccounts();
  if (accounts.length < 2) throw new Error("Hardhat node returned too few accounts");

  // In ethers v6, JsonRpcProvider.listAccounts() may return Signer objects.
  const clientSigner = accounts[0];
  const clientAddress = await clientSigner.getAddress();
  const contractorSigners = accounts.slice(1, 1 + maxContractors);
  const contractorAddresses = await Promise.all(contractorSigners.map((s) => s.getAddress()));

  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, clientSigner);
  const contract = await factory.deploy();
  const deployTx = await contract.deploymentTransaction();
  const receipt = await deployTx.wait();

  const contractAddress = await contract.getAddress();
  const gasPrice = safeGetGasPrice(receipt);
  const gasUsed = receipt.gasUsed ?? null;
  const gasCostWei = gasPrice && gasUsed ? gasUsed * gasPrice : null;

  return {
    runId: crypto.randomUUID(),
    contract,
    contractAddress,
    clientAddress,
    contractorAddresses,
    contractorSigners,
    maxContractors,
    deployReceipt: {
      txHash: receipt.hash,
      gasUsed: gasUsed ? gasUsed.toString() : null,
      gasPrice: gasPrice ? gasPrice.toString() : null,
      gasCostEth: formatMaybeEther(gasCostWei),
    },
  };
}

async function stepCreateTask({
  provider,
  run,
  description,
  rewardEth,
}) {
  if (!run?.contract) throw new Error("Deploy the contract first");
  if (!description || typeof description !== "string") throw new Error("description is required");
  if (!rewardEth) throw new Error("rewardEth is required");

  const clientKeys = generateKeyPair();
  const rewardWei = ethers.parseEther(String(rewardEth));

  // For UI transfer display, compute from rewardWei + tx gas cost.
  // (Balance-delta approach can be misleading depending on RPC/pending state.)

  const tx = await run.contract
    .connect(await provider.getSigner(run.clientAddress))
    .createTask(description, rewardWei, { value: rewardWei });
  const receipt = await tx.wait();

  const events = parseEvents(run.contract, receipt.logs);
  const taskCreatedEvt = events.find((e) => e && e.name === "TaskCreated");
  const taskId = taskCreatedEvt ? taskCreatedEvt.args.taskId : null;
  if (taskId === null) throw new Error("TaskCreated event not found");

  const gasPrice = safeGetGasPrice(receipt);
  const gasUsed = receipt.gasUsed ?? null;
  const gasCostWei = gasPrice && gasUsed ? gasUsed * gasPrice : null;

  run.clientKeys = clientKeys;
  run.taskId = taskId;
  run.rewardWei = rewardWei;
  run.description = description;

  return {
    taskId: taskId.toString(),
    rewardEth: String(rewardEth),
    contractBalanceDeltaEth: ethers.formatEther(rewardWei),
    clientBalanceDeltaEth:
      gasCostWei !== null ? ethers.formatEther(-(rewardWei + gasCostWei)) : null,
    createTaskReceipt: {
      txHash: receipt.hash,
      gasUsed: gasUsed ? gasUsed.toString() : null,
      gasPrice: gasPrice ? gasPrice.toString() : null,
      gasCostEth: formatMaybeEther(gasCostWei),
    },
  };
}

async function stepSubmitContractors({
  provider,
  run,
  contractorValues,
}) {
  if (!run?.contract || run.taskId === undefined) throw new Error("Create a task first");
  if (!Array.isArray(contractorValues) || contractorValues.length < 1) {
    throw new Error("contractorValues must be a non-empty array");
  }

  const N = contractorValues.length;
  if (N > run.maxContractors) throw new Error(`Max supported contractors is ${run.maxContractors}`);

  const clientKeys = run.clientKeys;
  if (!clientKeys) throw new Error("Missing client keys (createTask not run?)");

  // balances per contractor (for this step only)
  const submissions = [];

  for (let i = 0; i < N; i++) {
    const value = contractorValues[i];
    const signer = run.contractorSigners[i];
    const addr = await signer.getAddress();

    const before = await provider.getBalance(addr);

    const conKeys = generateKeyPair();
    const cipher = encrypt(value, clientKeys.pk);
    const proof = generateProof(cipher, conKeys.pkBytes);

    const offChainOk = verifyProof(
      {
        C1: cipher.C1,
        C2: cipher.C2,
        C4: cipher.C4,
        R: proof.R,
        z: proof.z,
      },
      conKeys.pkBytes
    );

    const tx = await run.contract
      .connect(signer)
      .submitResult(
        run.taskId,
        cipher.C1,
        cipher.C2,
        cipher.C4,
        proof.R,
        proof.z,
        conKeys.pkBytes
      );
    const receipt = await tx.wait();

    const gasPrice = safeGetGasPrice(receipt);
    const gasUsed = receipt.gasUsed ?? null;
    const gasCostWei = gasPrice && gasUsed ? gasUsed * gasPrice : null;

    const after = await provider.getBalance(addr);
    const balanceDeltaWei = after - before;

    const events = parseEvents(run.contract, receipt.logs);
    const submittedEvt = events.find((e) => e && e.name === "ResultSubmitted");
    const proofValidOnChain = submittedEvt ? submittedEvt.args.proofValid : false;

    submissions.push({
      contractorIndex: i + 1,
      contractorAddress: addr,
      submittedValue: Number(value),
      offChainProofValid: offChainOk,
      onChainProofValid: Boolean(proofValidOnChain),
      submitTxHash: receipt.hash,
      gas: {
        gasUsed: gasUsed ? gasUsed.toString() : null,
        gasCostEth: formatMaybeEther(gasCostWei),
      },
      balanceDeltaEth: ethers.formatEther(balanceDeltaWei),
      debug: {
        C1: cipher.C1.toString("hex").slice(0, 16) + "...",
        C2: cipher.C2.toString("hex").slice(0, 16) + "...",
        C4: cipher.C4.toString("hex").slice(0, 16) + "...",
        R: proof.R.toString("hex").slice(0, 16) + "...",
      },
    });
  }

  run.submissionVerdicts = submissions.map((s) => Boolean(s.onChainProofValid));

  return { submissions };
}

async function stepFinalizeTask({ provider, run }) {
  if (!run?.contract || run.taskId === undefined) throw new Error("Submit contractors first");
  if (!run?.contractorSigners) throw new Error("Missing contractor signers");

  const contractorSigners = run.contractorSigners;

  const activeContractorSigners = Array.isArray(run.contractorValues)
    ? run.contractorValues.map((_, idx) => contractorSigners[idx]).filter(Boolean)
    : contractorSigners;

  const clientSigner = await provider.getSigner(run.clientAddress);

  const tx = await run.contract.connect(clientSigner).finalizeTask(run.taskId);
  const receipt = await tx.wait();

  const events = parseEvents(run.contract, receipt.logs);
  const taskFinalizedEvt = events.find((e) => e && e.name === "TaskFinalized");
  const majorityCount = taskFinalizedEvt ? taskFinalizedEvt.args.majorityCount : null;
  const totalSubmissions = taskFinalizedEvt ? taskFinalizedEvt.args.totalSubmissions : null;

  const winningC4 = taskFinalizedEvt ? taskFinalizedEvt.args.winningC4 : null;

  const rewardedEvents = events.filter((e) => e && e.name === "ContractorRewarded");
  const rejectedEvents = events.filter((e) => e && e.name === "ContractorRejected");

  const rewarded = new Map(); // addrLower -> amountWei
  rewardedEvents.forEach((e) => rewarded.set(String(e.args.contractor).toLowerCase(), e.args.amount));

  const rejected = new Map(); // addrLower -> reason
  rejectedEvents.forEach((e) => rejected.set(String(e.args.contractor).toLowerCase(), e.args.reason));

  const gasPrice = safeGetGasPrice(receipt);
  const gasUsed = receipt.gasUsed ?? null;
  const gasCostWei = gasPrice && gasUsed ? gasUsed * gasPrice : null;

  const rewardedTotalWei = rewardedEvents.reduce((acc, e) => acc + BigInt(e.args.amount), 0n);
  const contractBalanceDeltaEth = ethers.formatEther(-rewardedTotalWei);
  const clientBalanceDeltaEth = gasCostWei !== null ? ethers.formatEther(-gasCostWei) : null;

  // build per-contractor table from active contractor signers
  const results = activeContractorSigners.map((signer, idx) => {
    const addr = signer.address.toLowerCase();
    const rewardAmountWei = rewarded.get(addr) ?? null;
    const reason = rejected.get(addr) ?? null;
    return {
      contractorIndex: idx + 1,
      contractorAddress: addr,
      rewarded: rewardAmountWei !== null,
      rewardAmountEth: rewardAmountWei !== null ? ethers.formatEther(rewardAmountWei) : null,
      rejected: reason !== null && rewardAmountWei === null,
      rejectReason: reason,
      transferDeltaEth: rewardAmountWei !== null ? ethers.formatEther(rewardAmountWei) : "0.0",
    };
  });

  run.winningC4 = winningC4;

  return {
    majorityCount: majorityCount !== null ? majorityCount.toString() : null,
    totalSubmissions: totalSubmissions !== null ? totalSubmissions.toString() : null,
    winningC4: winningC4 ? String(winningC4).slice(0, 16) + "..." : null,
    finalizeReceipt: {
      txHash: receipt.hash,
      gasUsed: gasUsed ? gasUsed.toString() : null,
      gasCostEth: formatMaybeEther(gasCostWei),
      clientBalanceDeltaEth,
    },
    contractBalanceDeltaEth,
    contractors: results,
  };
}

async function stepDecrypt({ provider, run }) {
  if (!run?.contract || run.taskId === undefined) throw new Error("Task not ready for decryption");
  if (!run?.clientKeys) throw new Error("Missing client keys");

  const [C1bytes, C2bytes, _C4bytes] = await run.contract.getWinningCiphertext(run.taskId);

  const C1buf = hexToBuffer(C1bytes);
  const C2buf = hexToBuffer(C2bytes);

  const submitted = Array.isArray(run.contractorValues) ? run.contractorValues.map(Number) : [];
  const verdicts = Array.isArray(run.submissionVerdicts) ? run.submissionVerdicts : null;
  const verifiedSubmitted = verdicts
    ? submitted.filter((_, i) => verdicts[i])
    : submitted;
  const candidates = [...new Set(submitted)];
  const result =
    candidates.length > 0
      ? decrypt(C1buf, C2buf, run.clientKeys.sk, candidates)
      : null;

  const decryptedValue = result === null ? null : Number(result);
  const plurality = pluralityFromValues(
    verifiedSubmitted.length > 0 ? verifiedSubmitted : submitted
  );
  const matchesMajority =
    decryptedValue !== null && plurality !== null
      ? decryptedValue === plurality.value
      : null;

  return {
    decryptedValue,
    majorityValue: plurality ? plurality.value : null,
    majorityCount: plurality ? plurality.count : null,
    matchesMajority,
  };
}

module.exports = {
  stepDeploy,
  stepCreateTask,
  stepSubmitContractors,
  stepFinalizeTask,
  stepDecrypt,
};

