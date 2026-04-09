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
const {
  mulG1,
  deriveScalarForOldScheme,
  g1ToUncompressed64,
  randomScalar32,
  buildPairingFreeSubmission,
  randomScalarBN,
} = require("../utils/crypto/bn254_g1");

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

async function resolveTaskIdFromReceipt({ scheme, receipt }) {
  // Primary path: parse logs from this tx receipt.
  const events = parseEvents(scheme.contract, receipt.logs);
  const taskCreatedEvt = events.find((e) => e && e.name === "TaskCreated");
  if (taskCreatedEvt?.args?.taskId !== undefined && taskCreatedEvt?.args?.taskId !== null) {
    return taskCreatedEvt.args.taskId;
  }

  // Fallback 1: query TaskCreated events in the exact mined block.
  try {
    const evs = await scheme.contract.queryFilter(
      scheme.contract.filters.TaskCreated(),
      receipt.blockNumber,
      receipt.blockNumber
    );
    const byTx = evs.find((e) => String(e.transactionHash).toLowerCase() === String(receipt.hash).toLowerCase());
    if (byTx?.args?.taskId !== undefined && byTx?.args?.taskId !== null) return byTx.args.taskId;
    if (evs.length > 0 && evs[evs.length - 1]?.args?.taskId !== undefined) {
      return evs[evs.length - 1].args.taskId;
    }
  } catch (_) {
    // continue to final fallback
  }

  // Fallback 2: monotonic counter on-chain.
  return await scheme.contract.taskCount();
}

function safeGetGasPrice(receipt) {
  return receipt.effectiveGasPrice ?? receipt.gasPrice ?? null;
}

function formatMaybeEther(wei) {
  if (wei === null || wei === undefined) return null;
  return ethers.formatEther(wei);
}

async function computeSafeGasLimit({ provider, from, to, data }) {
  const latest = await provider.getBlock("latest");
  const blockLimit = latest?.gasLimit ?? 16_000_000n;
  const txCap = 16_000_000n; // stay under Hardhat tx gas cap
  const cap0 = blockLimit > 100_000n ? blockLimit - 100_000n : blockLimit;
  const cap = cap0 < txCap ? cap0 : txCap;

  let estimate;
  try {
    estimate = await provider.estimateGas({ from, to, data });
  } catch (e) {
    // If the node can't estimate (e.g. very heavy crypto paths), fall back to a
    // conservative near-block-limit value so the tx can still be executed.
    return cap;
  }

  // Keep headroom for opcode variance, but stay under block/tx caps.
  const buffered = (estimate * 120n) / 100n;
  return buffered < cap ? buffered : cap;
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
  // IMPORTANT: all signers must come from the SAME network/provider used by the API.
  // (Mixing hardhat runtime signers with JsonRpcProvider signers can deploy/create on one
  // network and submit on another, which causes "task does not exist".)
  let addresses = [];
  if (provider && typeof provider.send === "function") {
    try {
      addresses = await provider.send("eth_accounts", []);
    } catch (_) {
      addresses = [];
    }
  }

  // Fallback for direct hardhat runtime usage (scripts/tests).
  if (!Array.isArray(addresses) || addresses.length < 2) {
    const hhSigners = await require("hardhat").ethers.getSigners();
    addresses = await Promise.all(hhSigners.map((s) => s.getAddress()));
  }

  if (!Array.isArray(addresses) || addresses.length < 2) {
    throw new Error("Hardhat node returned too few accounts");
  }

  const clientAddress = addresses[0];
  const clientSigner = await provider.getSigner(clientAddress);

  const nativeContractorAddresses = addresses.slice(1);
  const nativeUseCount = Math.min(maxContractors, nativeContractorAddresses.length);
  const contractorAddresses = nativeContractorAddresses.slice(0, nativeUseCount);
  const contractorSigners = await Promise.all(contractorAddresses.map((a) => provider.getSigner(a)));

  // Provision extra funded wallets when requested contractors exceed node-provided accounts.
  // This removes the practical cap from Hardhat's default account list.
  const missing = maxContractors - contractorSigners.length;
  if (missing > 0) {
    const oneEthHex = `0x${(10n ** 18n).toString(16)}`;
    for (let i = 0; i < missing; i++) {
      const wallet = ethers.Wallet.createRandom().connect(provider);
      await provider.send("hardhat_setBalance", [wallet.address, oneEthHex]);
      contractorSigners.push(wallet);
      contractorAddresses.push(wallet.address);
    }
  }

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
      deployGasUsed: gasUsed ? BigInt(gasUsed) : 0n,
      createTaskGasUsed: 0n,
      submitGasUsed: 0n,
      finalizeGasUsed: 0n,
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
    const taskId = await resolveTaskIdFromReceipt({ scheme, receipt });
    if (taskId === null || taskId === undefined) {
      throw new Error(`TaskCreated event not found for ${schemeKey}`);
    }
    const gasPrice = safeGetGasPrice(receipt);
    const gasUsed = receipt.gasUsed ?? null;
    const gasCostWei = gasPrice && gasUsed ? gasUsed * gasPrice : null;
    scheme.taskId = taskId;
    const used = gasUsed ? BigInt(gasUsed) : 0n;
    scheme.createTaskGasUsed += used;
    scheme.totalGasUsed += used;
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
    const bnSk = randomScalarBN();
    const bnPk = g1ToUncompressed64(mulG1(bnSk));
    const cipher = encrypt(value, clientKeys.pk);
    const proof = generateProof(cipher, conKeys.pkBytes);
    const bnProof = buildPairingFreeSubmission(value, bnPk);

    const offChainOk = verifyProof(
      {
        C1: cipher.C1,
        C3: cipher.C3,
        C4: cipher.C4,
        A1: proof.A1,
        A4: proof.A4,
        zr: proof.zr,
      },
      conKeys.pkBytes
    );

    const submitOne = async (schemeKey) => {
      const scheme = run.schemes[schemeKey];
      const to = await scheme.contract.getAddress();
      let submitArgs;
      if (schemeKey === "newScheme") {
        submitArgs = [
          scheme.taskId,
          bnProof.C1,
          cipher.C1,
          cipher.C2,
          bnProof.C3,
          bnProof.C4,
          bnProof.A1,
          bnProof.A4,
          bnProof.zr,
          bnPk,
        ];
      } else {
        // Old/pairing scheme expects:
        //   submitResult(taskId, C1, C2, C3, R(64), z(32), pkE)
        const z = randomScalar32();
        const sOld = deriveScalarForOldScheme({
          C1: Buffer.from(cipher.C1),
          C2: Buffer.from(cipher.C2),
          C3: Buffer.from(cipher.C3),
          zBytes: Buffer.from(z),
          pkE: Buffer.from(conKeys.pkBytes),
        });
        const Rpt = mulG1(sOld);
        submitArgs = [
          scheme.taskId,
          cipher.C1,
          cipher.C2,
          cipher.C3,
          g1ToUncompressed64(Rpt),
          z,
          conKeys.pkBytes,
        ];
      }

      const data = scheme.contract.interface.encodeFunctionData("submitResult", submitArgs);
      const gasLimit = await computeSafeGasLimit({
        provider,
        from: addr,
        to,
        data,
      });
      const tx = await signer.sendTransaction({
        to,
        data,
        gasLimit,
      });
      const receipt = await tx.wait();
      const gasPrice = safeGetGasPrice(receipt);
      const gasUsed = receipt.gasUsed ?? null;
      const gasCostWei = gasPrice && gasUsed ? gasUsed * gasPrice : null;
      const events = parseEvents(scheme.contract, receipt.logs);
      const submittedEvt = events.find((e) => e && e.name === "ResultSubmitted");
      const proofValidOnChain = submittedEvt ? submittedEvt.args.proofValid : false;
      const used = gasUsed ? BigInt(gasUsed) : 0n;
      scheme.submitGasUsed += used;
      scheme.totalGasUsed += used;
      return {
        txHash: receipt.hash,
        gasUsed: gasUsed ? gasUsed.toString() : null,
        gasCostEth: formatMaybeEther(gasCostWei),
        onChainProofValid: Boolean(proofValidOnChain),
      };
    };
    // Nonce-safe ordering: with automine enabled, parallel tx submission from the
    // same signer can race and trigger "nonce too low" on one branch.
    const newSub = await submitOne("newScheme");
    const oldSub = await submitOne("oldScheme");

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
        C1: (newSub.onChainProofValid ? bnProof.C1 : cipher.C1).toString("hex").slice(0, 16) + "...",
        C2: cipher.C2.toString("hex").slice(0, 16) + "...",
        C3: (newSub.onChainProofValid ? bnProof.C3 : cipher.C3).toString("hex").slice(0, 16) + "...",
        C4: (newSub.onChainProofValid ? bnProof.C4 : cipher.C4).toString("hex").slice(0, 16) + "...",
        A1: (newSub.onChainProofValid ? bnProof.A1 : proof.A1).toString("hex").slice(0, 16) + "...",
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
    const to = await scheme.contract.getAddress();
    const data = scheme.contract.interface.encodeFunctionData("finalizeTask", [scheme.taskId]);
    const gasLimit = await computeSafeGasLimit({
      provider,
      from: run.clientAddress,
      to,
      data,
    });
    const tx = await clientSigner.sendTransaction({
      to,
      data,
      gasLimit,
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
    const used = gasUsed ? BigInt(gasUsed) : 0n;
    scheme.finalizeGasUsed += used;
    scheme.totalGasUsed += used;
    return {
      majorityCount: taskFinalizedEvt ? taskFinalizedEvt.args.majorityCount : null,
      totalSubmissions: taskFinalizedEvt ? taskFinalizedEvt.args.totalSubmissions : null,
      winningC3: taskFinalizedEvt ? taskFinalizedEvt.args.winningC3 : null,
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
  // Finalize uses the same client signer for both schemes; keep sequential for nonce safety.
  const newOut = await finalizeOne("newScheme");
  const oldOut = await finalizeOne("oldScheme");

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

  run.winningC3 = newOut.winningC3;
  run.totalGas = {
    newScheme: run.schemes.newScheme.totalGasUsed,
    oldScheme: run.schemes.oldScheme.totalGasUsed,
  };
  run.runtimeGas = {
    newScheme:
      run.schemes.newScheme.createTaskGasUsed +
      run.schemes.newScheme.submitGasUsed +
      run.schemes.newScheme.finalizeGasUsed,
    oldScheme:
      run.schemes.oldScheme.createTaskGasUsed +
      run.schemes.oldScheme.submitGasUsed +
      run.schemes.oldScheme.finalizeGasUsed,
  };
  run.submitGas = {
    newScheme: run.schemes.newScheme.submitGasUsed,
    oldScheme: run.schemes.oldScheme.submitGasUsed,
  };

  return {
    majorityCount: newOut.majorityCount !== null ? newOut.majorityCount.toString() : null,
    totalSubmissions: newOut.totalSubmissions !== null ? newOut.totalSubmissions.toString() : null,
    winningC3: newOut.winningC3 ? String(newOut.winningC3).slice(0, 16) + "..." : null,
    finalizeReceipt: {
      newScheme: newOut.receipt,
      oldScheme: oldOut.receipt,
    },
    contractBalanceDeltaEth: newOut.contractBalanceDeltaEth,
    contractors: results,
    gasComparison: {
      newScheme: {
        totalGas: run.totalGas.newScheme.toString(),
        runtimeGas: run.runtimeGas.newScheme.toString(),
        submitGas: run.submitGas.newScheme.toString(),
      },
      oldScheme: {
        totalGas: run.totalGas.oldScheme.toString(),
        runtimeGas: run.runtimeGas.oldScheme.toString(),
        submitGas: run.submitGas.oldScheme.toString(),
      },
      deltaGas: (run.totalGas.oldScheme - run.totalGas.newScheme).toString(),
      deltaRuntimeGas: (run.runtimeGas.oldScheme - run.runtimeGas.newScheme).toString(),
      deltaSubmitGas: (run.submitGas.oldScheme - run.submitGas.newScheme).toString(),
      ratioOldToNew:
        run.totalGas.newScheme > 0n
          ? Number(run.totalGas.oldScheme) / Number(run.totalGas.newScheme)
          : null,
      ratioRuntimeOldToNew:
        run.runtimeGas.newScheme > 0n
          ? Number(run.runtimeGas.oldScheme) / Number(run.runtimeGas.newScheme)
          : null,
      ratioSubmitOldToNew:
        run.submitGas.newScheme > 0n
          ? Number(run.submitGas.oldScheme) / Number(run.submitGas.newScheme)
          : null,
    },
  };
}

async function stepDecrypt({ provider, run }) {
  if (!run?.schemes?.newScheme?.contract || run?.schemes?.newScheme?.taskId === undefined) {
    throw new Error("Task not ready for decryption");
  }
  if (!run?.clientKeys) throw new Error("Missing client keys");

  const [C1bytes, C2bytes, _C3bytes] = await run.schemes.newScheme.contract.getWinningCiphertext(
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

