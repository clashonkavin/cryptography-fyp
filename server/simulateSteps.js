const crypto = require("node:crypto");
const { ethers } = require("ethers");

const artifactNew = require("../artifacts/contracts/OutsourcedComputation.sol/OutsourcedComputation.json");
const artifactOld = require("../artifacts/contracts/OutsourcedComputationPairing.sol/OutsourcedComputationPairing.json");
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

  const deployOne = async (label, artifact) => {
    const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, clientSigner);
    const contract = await factory.deploy();
    const deployTx = await contract.deploymentTransaction();
    const receipt = await deployTx.wait();
    const gasPrice = safeGetGasPrice(receipt);
    const gasUsed = receipt.gasUsed ?? null;
    const gasCostWei = gasPrice && gasUsed ? gasUsed * gasPrice : null;
    return {
      label,
      contract,
      contractAddress: await contract.getAddress(),
      deployReceipt: {
        txHash: receipt.hash,
        gasUsed: gasUsed ? gasUsed.toString() : null,
        gasPrice: gasPrice ? gasPrice.toString() : null,
        gasCostEth: formatMaybeEther(gasCostWei),
      },
      totalGasUsed: gasUsed ? BigInt(gasUsed) : 0n,
    };
  };

  const [newScheme, oldScheme] = await Promise.all([
    deployOne("newScheme", artifactNew),
    deployOne("oldScheme", artifactOld),
  ]);

  return {
    runId: crypto.randomUUID(),
    schemes: {
      newScheme,
      oldScheme,
    },
    contractAddress: newScheme.contractAddress,
    contractAddresses: {
      newScheme: newScheme.contractAddress,
      oldScheme: oldScheme.contractAddress,
    },
    clientAddress,
    contractorAddresses,
    contractorSigners,
    maxContractors,
    deployReceipt: {
      newScheme: newScheme.deployReceipt,
      oldScheme: oldScheme.deployReceipt,
    },
  };
}

async function stepCreateTask({
  provider,
  run,
  description,
  rewardEth,
}) {
  if (!run?.schemes?.newScheme?.contract || !run?.schemes?.oldScheme?.contract) {
    throw new Error("Deploy contracts first");
  }
  if (!description || typeof description !== "string") throw new Error("description is required");
  if (!rewardEth) throw new Error("rewardEth is required");

  const clientKeys = generateKeyPair();
  const rewardWei = ethers.parseEther(String(rewardEth));

  // For UI transfer display, compute from rewardWei + tx gas cost.
  // (Balance-delta approach can be misleading depending on RPC/pending state.)

  const clientSigner = await provider.getSigner(run.clientAddress);
  const runCreateTask = async (schemeKey) => {
    const scheme = run.schemes[schemeKey];
    const tx = await scheme.contract
      .connect(clientSigner)
      .createTask(description, rewardWei, { value: rewardWei });
    const receipt = await tx.wait();
    const events = parseEvents(scheme.contract, receipt.logs);
    const taskCreatedEvt = events.find((e) => e && e.name === "TaskCreated");
    const taskId = taskCreatedEvt ? taskCreatedEvt.args.taskId : null;
    if (taskId === null) throw new Error(`TaskCreated event not found for ${schemeKey}`);
    const gasPrice = safeGetGasPrice(receipt);
    const gasUsed = receipt.gasUsed ?? null;
    const gasCostWei = gasPrice && gasUsed ? gasUsed * gasPrice : null;
    scheme.taskId = taskId;
    scheme.totalGasUsed += gasUsed ? BigInt(gasUsed) : 0n;
    return {
      taskId: taskId.toString(),
      receipt: {
        txHash: receipt.hash,
        gasUsed: gasUsed ? gasUsed.toString() : null,
        gasPrice: gasPrice ? gasPrice.toString() : null,
        gasCostEth: formatMaybeEther(gasCostWei),
      },
      gasCostWei,
    };
  };
  const [newOut, oldOut] = await Promise.all([runCreateTask("newScheme"), runCreateTask("oldScheme")]);

  run.clientKeys = clientKeys;
  run.rewardWei = rewardWei;
  run.description = description;

  return {
    taskId: newOut.taskId,
    taskIds: {
      newScheme: newOut.taskId,
      oldScheme: oldOut.taskId,
    },
    rewardEth: String(rewardEth),
    contractBalanceDeltaEth: ethers.formatEther(rewardWei),
    clientBalanceDeltaEth:
      newOut.gasCostWei !== null ? ethers.formatEther(-(rewardWei + newOut.gasCostWei)) : null,
    createTaskReceipt: {
      newScheme: newOut.receipt,
      oldScheme: oldOut.receipt,
    },
  };
}

async function stepSubmitContractors({
  provider,
  run,
  contractorValues,
}) {
  if (!run?.schemes?.newScheme?.contract || !run?.schemes?.oldScheme?.contract) {
    throw new Error("Create a task first");
  }
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

    const submitOne = async (schemeKey) => {
      const scheme = run.schemes[schemeKey];
      const data = scheme.contract.interface.encodeFunctionData("submitResult", [
        scheme.taskId,
        cipher.C1,
        cipher.C2,
        cipher.C4,
        proof.R,
        proof.z,
        conKeys.pkBytes,
      ]);
      const tx = await signer.sendTransaction({
        to: await scheme.contract.getAddress(),
        data,
        gasLimit: 8_000_000n,
      });
      const receipt = await tx.wait();
      const gasPrice = safeGetGasPrice(receipt);
      const gasUsed = receipt.gasUsed ?? null;
      const gasCostWei = gasPrice && gasUsed ? gasUsed * gasPrice : null;
      const events = parseEvents(scheme.contract, receipt.logs);
      const submittedEvt = events.find((e) => e && e.name === "ResultSubmitted");
      const proofValidOnChain = submittedEvt ? submittedEvt.args.proofValid : false;
      scheme.totalGasUsed += gasUsed ? BigInt(gasUsed) : 0n;
      return {
        txHash: receipt.hash,
        gasUsed: gasUsed ? gasUsed.toString() : null,
        gasCostEth: formatMaybeEther(gasCostWei),
        onChainProofValid: Boolean(proofValidOnChain),
      };
    };
    const [newSub, oldSub] = await Promise.all([submitOne("newScheme"), submitOne("oldScheme")]);

    const after = await provider.getBalance(addr);
    const balanceDeltaWei = after - before;

    submissions.push({
      contractorIndex: i + 1,
      contractorAddress: addr,
      submittedValue: Number(value),
      offChainProofValid: offChainOk,
      onChainProofValid: Boolean(newSub.onChainProofValid),
      onChainProofValidOld: Boolean(oldSub.onChainProofValid),
      submitTxHash: newSub.txHash,
      gas: {
        newScheme: {
          gasUsed: newSub.gasUsed,
          gasCostEth: newSub.gasCostEth,
        },
        oldScheme: {
          gasUsed: oldSub.gasUsed,
          gasCostEth: oldSub.gasCostEth,
        },
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
  if (!run?.schemes?.newScheme?.contract || !run?.schemes?.oldScheme?.contract) {
    throw new Error("Submit contractors first");
  }
  if (!run?.contractorSigners) throw new Error("Missing contractor signers");

  const contractorSigners = run.contractorSigners;

  const activeContractorSigners = Array.isArray(run.contractorValues)
    ? run.contractorValues.map((_, idx) => contractorSigners[idx]).filter(Boolean)
    : contractorSigners;

  const clientSigner = await provider.getSigner(run.clientAddress);
  const finalizeOne = async (schemeKey) => {
    const scheme = run.schemes[schemeKey];
    const data = scheme.contract.interface.encodeFunctionData("finalizeTask", [scheme.taskId]);
    const tx = await clientSigner.sendTransaction({
      to: await scheme.contract.getAddress(),
      data,
      gasLimit: 10_000_000n,
    });
    const receipt = await tx.wait();
    const events = parseEvents(scheme.contract, receipt.logs);
    const taskFinalizedEvt = events.find((e) => e && e.name === "TaskFinalized");
    const rewardedEvents = events.filter((e) => e && e.name === "ContractorRewarded");
    const rejectedEvents = events.filter((e) => e && e.name === "ContractorRejected");
    const rewarded = new Map();
    rewardedEvents.forEach((e) => rewarded.set(String(e.args.contractor).toLowerCase(), e.args.amount));
    const rejected = new Map();
    rejectedEvents.forEach((e) => rejected.set(String(e.args.contractor).toLowerCase(), e.args.reason));
    const gasPrice = safeGetGasPrice(receipt);
    const gasUsed = receipt.gasUsed ?? null;
    const gasCostWei = gasPrice && gasUsed ? gasUsed * gasPrice : null;
    const rewardedTotalWei = rewardedEvents.reduce((acc, e) => acc + BigInt(e.args.amount), 0n);
    scheme.totalGasUsed += gasUsed ? BigInt(gasUsed) : 0n;
    return {
      majorityCount: taskFinalizedEvt ? taskFinalizedEvt.args.majorityCount : null,
      totalSubmissions: taskFinalizedEvt ? taskFinalizedEvt.args.totalSubmissions : null,
      winningC4: taskFinalizedEvt ? taskFinalizedEvt.args.winningC4 : null,
      receipt: {
        txHash: receipt.hash,
        gasUsed: gasUsed ? gasUsed.toString() : null,
        gasCostEth: formatMaybeEther(gasCostWei),
        clientBalanceDeltaEth: gasCostWei !== null ? ethers.formatEther(-gasCostWei) : null,
      },
      contractBalanceDeltaEth: ethers.formatEther(-rewardedTotalWei),
      rewarded,
      rejected,
    };
  };
  const [newOut, oldOut] = await Promise.all([finalizeOne("newScheme"), finalizeOne("oldScheme")]);

  // build per-contractor table from active contractor signers
  const results = activeContractorSigners.map((signer, idx) => {
    const addr = signer.address.toLowerCase();
    const rewardAmountWei = newOut.rewarded.get(addr) ?? null;
    const reason = newOut.rejected.get(addr) ?? null;
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

  run.winningC4 = newOut.winningC4;
  run.totalGas = {
    newScheme: run.schemes.newScheme.totalGasUsed,
    oldScheme: run.schemes.oldScheme.totalGasUsed,
  };

  return {
    majorityCount: newOut.majorityCount !== null ? newOut.majorityCount.toString() : null,
    totalSubmissions: newOut.totalSubmissions !== null ? newOut.totalSubmissions.toString() : null,
    winningC4: newOut.winningC4 ? String(newOut.winningC4).slice(0, 16) + "..." : null,
    finalizeReceipt: {
      newScheme: newOut.receipt,
      oldScheme: oldOut.receipt,
    },
    contractBalanceDeltaEth: newOut.contractBalanceDeltaEth,
    contractors: results,
    gasComparison: {
      newScheme: {
        totalGas: run.totalGas.newScheme.toString(),
      },
      oldScheme: {
        totalGas: run.totalGas.oldScheme.toString(),
      },
      deltaGas: (run.totalGas.oldScheme - run.totalGas.newScheme).toString(),
      ratioOldToNew:
        run.totalGas.newScheme > 0n
          ? Number(run.totalGas.oldScheme) / Number(run.totalGas.newScheme)
          : null,
    },
  };
}

async function stepDecrypt({ provider, run }) {
  if (!run?.schemes?.newScheme?.contract || run?.schemes?.newScheme?.taskId === undefined) {
    throw new Error("Task not ready for decryption");
  }
  if (!run?.clientKeys) throw new Error("Missing client keys");

  const [C1bytes, C2bytes, _C4bytes] = await run.schemes.newScheme.contract.getWinningCiphertext(
    run.schemes.newScheme.taskId
  );

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

