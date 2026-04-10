const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const hre = require("hardhat");
const { randomBytes } = require("node:crypto");
const {
  stepDeploy,
  stepCreateTask,
  stepSubmitContractors,
  stepFinalizeTask,
} = require("../../server/simulateSteps");
const { generateKeyPair, encrypt, generateProof, verifyProof } = require("../../utils/crypto");
const {
  buildPairingFreeSubmission,
  randomScalarBN,
  mulG1,
  g1ToUncompressed64,
} = require("../../utils/crypto/bn254_g1");

const N_VALUES = [1, 5, 10, 20, 50];
const ITERATIONS_M2 = Number(process.env.M2_ITERATIONS || "150");

function fmt(n) {
  return Number(n).toLocaleString("en-US");
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function regressionLinear(x, y) {
  const n = x.length;
  const sx = x.reduce((a, b) => a + b, 0);
  const sy = y.reduce((a, b) => a + b, 0);
  const sxy = x.reduce((a, xi, i) => a + xi * y[i], 0);
  const sxx = x.reduce((a, xi) => a + xi * xi, 0);
  const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  const intercept = (sy - slope * sx) / n;
  const yMean = sy / n;
  const ssTot = y.reduce((a, yi) => a + (yi - yMean) ** 2, 0);
  const ssRes = y.reduce((a, yi, i) => {
    const pred = slope * x[i] + intercept;
    return a + (yi - pred) ** 2;
  }, 0);
  const r2 = ssTot === 0 ? 1 : 1 - ssRes / ssTot;
  return { slope, intercept, r2 };
}

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function runM1M4M6(provider) {
  const rows = [];
  for (const n of N_VALUES) {
    const run = await stepDeploy({ provider, maxContractors: n + 2 });
    const values = Array.from({ length: n }, (_, i) => (i % 3 === 0 ? 25 : i % 3 === 1 ? 25 : 30));
    await stepCreateTask({
      provider,
      run,
      description: `Research benchmark n=${n}`,
      rewardEth: "0.05",
    });
    const submitted = await stepSubmitContractors({ provider, run, contractorValues: values });
    const finalized = await stepFinalizeTask({ provider, run });

    const submitGasNew = submitted.submissions.map((s) => Number(s.gas.newScheme.gasUsed));
    const submitGasOld = submitted.submissions.map((s) => Number(s.gas.oldScheme.gasUsed));
    const avgNew = mean(submitGasNew);
    const avgOld = mean(submitGasOld);

    const eqStart = performance.now();
    for (let i = 1; i < n; i++) {
      await run.schemes.newScheme.contract.equalityTest(run.schemes.newScheme.taskId, 0, i);
    }
    const eqElapsedMs = performance.now() - eqStart;

    const eqGasSamples = [];
    if (n > 1) {
      const sampleCount = Math.min(n - 1, 4);
      for (let i = 1; i <= sampleCount; i++) {
        const gas = Number(
          await run.schemes.newScheme.contract.equalityTest.estimateGas(
            run.schemes.newScheme.taskId,
            0,
            i
          )
        );
        eqGasSamples.push(gas);
      }
    } else {
      const gas = Number(
        await run.schemes.newScheme.contract.equalityTest.estimateGas(
          run.schemes.newScheme.taskId,
          0,
          0
        )
      );
      eqGasSamples.push(gas);
    }
    const eqGasTx = mean(eqGasSamples);
    const eqGasExec = Math.max(0, eqGasTx - 21000);

    rows.push({
      n,
      avgVerifyGasNew: avgNew,
      avgVerifyGasOld: avgOld,
      totalSubmitGasNew: Number(finalized.gasComparison.newScheme.submitGas),
      totalSubmitGasOld: Number(finalized.gasComparison.oldScheme.submitGas),
      eqTestBatchMs: eqElapsedMs,
      eqTestPerCompareMs: n > 1 ? eqElapsedMs / (n - 1) : eqElapsedMs,
      eqTestEstimatedGasSingleTx: eqGasTx,
      eqTestEstimatedGasSingleExec: eqGasExec,
    });
  }

  const x = rows.map((r) => r.n);
  const yNew = rows.map((r) => r.totalSubmitGasNew);
  const yOld = rows.map((r) => r.totalSubmitGasOld);
  const linNew = regressionLinear(x, yNew);
  const linOld = regressionLinear(x, yOld);

  return {
    perN: rows,
    baselineReference: {
      ecPairingGasApprox: 45000,
      ecMulGasApprox: 6000,
      source: "BN254 precompile rough constants used in literature/tooling",
    },
    scalability: {
      submitGasLinearFitNew: linNew,
      submitGasLinearFitOld: linOld,
      interpretation:
        "High R^2 near 1 indicates near-linear growth in total submit gas with contractor count.",
    },
  };
}

async function runM2() {
  let secp;
  try {
    secp = require("@noble/secp256k1");
  } catch (_) {
    return {
      iterations: 0,
      unavailable: true,
      note:
        "Install @noble/secp256k1 to enable M2 noble benchmark: npm install @noble/secp256k1",
    };
  }

  const encMs = [];
  const proofMs = [];
  const totalMs = [];
  for (let i = 0; i < ITERATIONS_M2; i++) {
    const keys = generateKeyPair();
    const value = 25 + (i % 7);

    const t0 = performance.now();
    const c = encrypt(value, keys.pk);
    const t1 = performance.now();
    const p = generateProof(c, keys.pkBytes);
    const t2 = performance.now();

    const sk = secp.utils.randomPrivateKey();
    const pk = secp.getPublicKey(sk, true);
    const msg = randomBytes(32);
    // noble API differs by version (sync verify vs async verifyAsync).
    const sig = typeof secp.signAsync === "function"
      ? await secp.signAsync(msg, sk)
      : secp.sign(msg, sk);
    const verifyResult = typeof secp.verifyAsync === "function"
      ? await secp.verifyAsync(sig, msg, pk)
      : secp.verify(sig, msg, pk);
    if (!verifyResult) {
      throw new Error("M2 noble sanity check failed: sign/verify returned false");
    }

    const ok = verifyProof(
      { C1: c.C1, C3: c.C3, C4: c.C4, A1: p.A1, A4: p.A4, zr: p.zr },
      keys.pkBytes
    );
    if (!ok) throw new Error("M2 sanity check failed: generated proof did not verify");

    encMs.push(t1 - t0);
    proofMs.push(t2 - t1);
    totalMs.push(t2 - t0);
  }

  return {
    iterations: ITERATIONS_M2,
    unavailable: false,
    meanEncryptMs: mean(encMs),
    meanProofGenMs: mean(proofMs),
    meanEncryptPlusProofMs: mean(totalMs),
    p95EncryptPlusProofMs: [...totalMs].sort((a, b) => a - b)[Math.floor(totalMs.length * 0.95)],
  };
}

function runM3() {
  const client = generateKeyPair();
  const contractor = generateKeyPair();
  const c = encrypt(25, client.pk);
  const p = generateProof(c, contractor.pkBytes);
  const newCtSize = c.C1.length + c.C2.length + c.C3.length + c.C4.length + p.A1.length + p.A4.length + p.zr.length;

  // Baseline A (repo old submit payload): C1(33), C2(33), C3(33), R(64), z(32), pkE(33)
  const oldCtSizeRepo = 33 + 33 + 33 + 64 + 32 + 33;
  // Baseline B (canonical pairing-style uncompressed-point payload approximation)
  // uses 64-byte points for C1/C2/C3/C4 + proof R(64) + z(32).
  const oldCtSizeCanonical = 64 + 64 + 64 + 64 + 64 + 32;

  return {
    newSchemeBytes: {
      C1: c.C1.length,
      C2: c.C2.length,
      C3: c.C3.length,
      C4: c.C4.length,
      A1: p.A1.length,
      A4: p.A4.length,
      zr: p.zr.length,
      total: newCtSize,
    },
    oldPairingBaselineRepoBytes: {
      C1: 33,
      C2: 33,
      C3: 33,
      R: 64,
      z: 32,
      pkE: 33,
      total: oldCtSizeRepo,
    },
    oldPairingBaselineCanonicalBytes: {
      C1: 64,
      C2: 64,
      C3: 64,
      C4: 64,
      R: 64,
      z: 32,
      total: oldCtSizeCanonical,
    },
    deltaBytesOldRepoMinusNew: oldCtSizeRepo - newCtSize,
    deltaBytesOldCanonicalMinusNew: oldCtSizeCanonical - newCtSize,
  };
}

async function runM5(provider) {
  const run = await stepDeploy({ provider, maxContractors: 3 });
  await stepCreateTask({
    provider,
    run,
    description: "M5 security test task",
    rewardEth: "0.01",
  });
  const submitter = run.contractorSigners[0];
  const submitAddr = await submitter.getAddress();
  const contract = run.schemes.newScheme.contract;
  const taskId = run.schemes.newScheme.taskId;

  const parseProofValid = (receipt) => {
    const logs = receipt.logs || [];
    for (const log of logs) {
      try {
        const p = contract.interface.parseLog(log);
        if (p && p.name === "ResultSubmitted") return Boolean(p.args.proofValid);
      } catch (_) {
        // ignore non-matching logs
      }
    }
    return false;
  };

  const client = generateKeyPair();
  const value = 25;
  const c = encrypt(value, client.pk);
  const bnSk = randomScalarBN();
  const bnPk = g1ToUncompressed64(mulG1(bnSk));
  const proof = buildPairingFreeSubmission(value, bnPk);

  const submitAndCheck = async ({
    name,
    expected,
    C1Proof = proof.C1,
    C1Decrypt = c.C1,
    C2 = c.C2,
    C3 = proof.C3,
    C4 = proof.C4,
    A1 = proof.A1,
    A4 = proof.A4,
    zr = proof.zr,
    pkE = bnPk,
  }) => {
    const tx = await contract.connect(submitter).submitResult(
      taskId,
      C1Proof,
      C1Decrypt,
      C2,
      C3,
      C4,
      A1,
      A4,
      zr,
      pkE
    );
    const receipt = await tx.wait();
    const observed = parseProofValid(receipt);
    return {
      name,
      expected,
      observed,
      passed: observed === expected,
      txHash: receipt.hash,
      submitter: submitAddr,
    };
  };

  const otherBnPk = g1ToUncompressed64(mulG1(randomScalarBN()));
  const forgedC3 = Buffer.from(proof.C3);
  forgedC3[0] ^= 0x01;

  const variants = [];
  variants.push(await submitAndCheck({ name: "LE-Honest", expected: true }));
  variants.push(
    await submitAndCheck({
      name: "LE-CopyAttack-DifferentPkE",
      expected: false,
      pkE: otherBnPk,
    })
  );
  variants.push(
    await submitAndCheck({
      name: "LE-C3Forgery",
      expected: false,
      C3: forgedC3,
    })
  );
  variants.push(
    await submitAndCheck({
      name: "LE-r0-MalformedResponse",
      expected: false,
      zr: Buffer.alloc(32, 0),
    })
  );

  return {
    testMode: "on-chain submitResult adversarial simulation",
    variants,
  };
}

function buildHtml(report) {
  const m1Rows = report.M1.perN
    .map(
      (r) => `<tr><td>${r.n}</td><td>${fmt(r.avgVerifyGasNew)}</td><td>${fmt(r.avgVerifyGasOld)}</td><td>${fmt(
        r.eqTestEstimatedGasSingleExec
      )}</td><td>${r.eqTestPerCompareMs.toFixed(3)}</td></tr>`
    )
    .join("");
  const m5Rows = report.M5.variants
    .map(
      (v) =>
        `<tr><td>${v.name}</td><td>${String(v.expected)}</td><td>${String(v.observed)}</td><td>${v.txHash || ""}</td><td class="${
          v.passed ? "ok" : "bad"
        }">${v.passed ? "PASS" : "FAIL"}</td></tr>`
    )
    .join("");

  const m4Rows = report.M4.perN
    .map(
      (r) =>
        `<tr><td>${r.n}</td><td>${r.eqTestBatchMs.toFixed(3)}</td><td>${r.eqTestPerCompareMs.toFixed(3)}</td><td>${fmt(
          r.eqTestEstimatedGasSingleExec
        )}</td><td>${fmt(r.eqTestEstimatedGasSingleTx)}</td></tr>`
    )
    .join("");
  return `<!doctype html>
<html><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Research Benchmarks M1-M6</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
<style>
body{font-family:Inter,Arial,sans-serif;background:#f4f7ff;color:#0f172a;margin:0}
.wrap{max-width:1500px;margin:0 auto;padding:28px}
.hero{background:#fff;border:1px solid #dbe3f4;border-radius:16px;padding:18px;margin-bottom:16px}
.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}
.card{background:#fff;border:1px solid #dbe3f4;border-radius:12px;padding:12px}
.span2{grid-column:span 2}
.span4{grid-column:span 4}
table{width:100%;border-collapse:collapse}th,td{border:1px solid #e5e7eb;padding:8px;text-align:left}
th{background:#f8fafc}.ok{color:#166534;font-weight:700}.bad{color:#b91c1c;font-weight:700}
@media(max-width:900px){.grid{grid-template-columns:1fr}.span2,.span4{grid-column:span 1}}
</style>
</head>
<body><div class="wrap">
<div class="hero">
<h1>Research Benchmarks (M1-M6)</h1>
<p>Generated: <code>${report.generatedAt}</code></p>
<p>M6 linearity (new/old R²): <b>${report.M6.submitGasLinearFitNew.r2.toFixed(4)}</b> / <b>${report.M6.submitGasLinearFitOld.r2.toFixed(4)}</b></p>
<p>M1 baseline refs: ecPairing ~<b>${fmt(report.M1.baselineReference.ecPairingGasApprox)}</b> gas, ecMul ~<b>${fmt(
    report.M1.baselineReference.ecMulGasApprox
  )}</b> gas.</p>
</div>
<div class="grid">
<div class="card span2"><canvas id="m1Gas"></canvas></div>
<div class="card span2"><canvas id="m6Linear"></canvas></div>
<div class="card span2"><canvas id="m4Eq"></canvas></div>
<div class="card span2"><canvas id="m3Size"></canvas></div>
<div class="card span2"><h3>M3 Ciphertext Size</h3><p>New total (CT tuple): <b>${report.M3.newSchemeBytes.total} B</b><br/>Old baseline (repo payload): <b>${report.M3.oldPairingBaselineRepoBytes.total} B</b><br/>Old baseline (canonical pairing): <b>${report.M3.oldPairingBaselineCanonicalBytes.total} B</b><br/>Delta canonical-old minus new: <b>${report.M3.deltaBytesOldCanonicalMinusNew} B</b></p></div>
<div class="card span2"><h3>M2 Proof Generation Time</h3><p>${
    report.M2.unavailable
      ? report.M2.note
      : `Mean encrypt+proof: <b>${report.M2.meanEncryptPlusProofMs.toFixed(3)} ms</b><br/>P95: <b>${report.M2.p95EncryptPlusProofMs.toFixed(3)} ms</b><br/>Iterations: ${report.M2.iterations}`
  }</p></div>
<div class="card span4"><h3>M1 + M4 Table</h3><table><thead><tr><th>n (contractors)</th><th>Avg verify gas new</th><th>Avg verify gas old</th><th>EqTest exec gas (est)</th><th>EqTest ms/compare</th></tr></thead><tbody>${m1Rows}</tbody></table></div>
<div class="card span4"><h3>M4 Latency Table</h3><table><thead><tr><th>n (contractors)</th><th>Batch latency (ms)</th><th>Per compare (ms)</th><th>EqTest exec gas (est)</th><th>EqTest tx gas incl 21k</th></tr></thead><tbody>${m4Rows}</tbody></table></div>
<div class="card span4"><h3>M5 Security Tests</h3><p>Mode: <code>${report.M5.testMode || ""}</code></p><table><thead><tr><th>Variant</th><th>Expected</th><th>Observed</th><th>Tx hash</th><th>Result</th></tr></thead><tbody>${m5Rows}</tbody></table></div>
</div>
<script>
const rows = ${JSON.stringify(report.M1.perN)};
const eqRows = ${JSON.stringify(report.M4.perN)};
new Chart(document.getElementById("m1Gas"),{
 type:"bar",
 data:{labels:rows.map(r=>String(r.n)),datasets:[{label:"New avg verify gas",data:rows.map(r=>r.avgVerifyGasNew)},{label:"Old avg verify gas",data:rows.map(r=>r.avgVerifyGasOld)}]},
 options:{scales:{x:{title:{display:true,text:"Number of contractors (n)"}},y:{title:{display:true,text:"Gas per submission verification"}}}}
});
new Chart(document.getElementById("m6Linear"),{
 type:"line",
 data:{labels:rows.map(r=>String(r.n)),datasets:[{label:"New total submit gas",data:rows.map(r=>r.totalSubmitGasNew)},{label:"Old total submit gas",data:rows.map(r=>r.totalSubmitGasOld)}]},
 options:{scales:{x:{title:{display:true,text:"Number of contractors (n)"}},y:{title:{display:true,text:"Total submit gas"}}}}
});
new Chart(document.getElementById("m4Eq"),{
 type:"line",
 data:{labels:eqRows.map(r=>String(r.n)),datasets:[{label:"EqTest batch latency (ms)",data:eqRows.map(r=>r.eqTestBatchMs)},{label:"EqTest per-compare latency (ms)",data:eqRows.map(r=>r.eqTestPerCompareMs)}]},
 options:{scales:{x:{title:{display:true,text:"Number of contractors (n)"}},y:{type:"linear",position:"left",title:{display:true,text:"Latency (ms)"}}}}
});
new Chart(document.getElementById("m3Size"),{
 type:"bar",
 data:{labels:["New CT","Old repo payload","Old canonical pairing"],datasets:[{label:"Bytes",data:[${report.M3.newSchemeBytes.total},${report.M3.oldPairingBaselineRepoBytes.total},${report.M3.oldPairingBaselineCanonicalBytes.total}]}]},
 options:{scales:{x:{title:{display:true,text:"Scheme/baseline"}},y:{title:{display:true,text:"Ciphertext/proof payload size (bytes)"}}}}
});
</script>
</div></body></html>`;
}

async function runResearchBenchmarks({ provider, log = console.log } = {}) {
  const activeProvider = provider || hre.ethers.provider;
  log("Running research benchmark suite (M1-M6)...");
  const m1m4m6 = await runM1M4M6(activeProvider);
  const m2 = await runM2();
  const m3 = runM3();
  const m5 = await runM5(activeProvider);

  const report = {
    generatedAt: new Date().toISOString(),
    M1: {
      description: "On-chain gas per ciphertext verification versus pairing baseline.",
      ...m1m4m6,
    },
    M2: {
      description: "Off-chain wall-clock time for encrypt + DLEQ proof generation.",
      ...m2,
    },
    M3: {
      description: "Ciphertext byte-size comparison.",
      ...m3,
    },
    M4: {
      description: "EqTest latency and gas estimates across n.",
      perN: m1m4m6.perN.map((r) => ({
        n: r.n,
        eqTestBatchMs: r.eqTestBatchMs,
        eqTestPerCompareMs: r.eqTestPerCompareMs,
        eqTestEstimatedGasSingleExec: r.eqTestEstimatedGasSingleExec,
        eqTestEstimatedGasSingleTx: r.eqTestEstimatedGasSingleTx,
      })),
      complexityStatement:
        "EqTest operation itself is a single equality check (constant-time primitive per comparison).",
    },
    M5: {
      description: "Adversarial LE variant tests.",
      ...m5,
    },
    M6: {
      description: "Scalability/linearity checks.",
      ...m1m4m6.scalability,
      eqTestComplexityClaim:
        "EqTest on-chain primitive is a single bytes equality check; gas per single call is near constant.",
    },
  };

  const outDir = path.join(__dirname, "..", "..", "reports", "research", nowStamp());
  fs.mkdirSync(outDir, { recursive: true });
  const jsonPath = path.join(outDir, "research-benchmark.json");
  const htmlPath = path.join(outDir, "research-benchmark.html");
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  fs.writeFileSync(htmlPath, buildHtml(report), "utf8");

  log(`Report directory: ${outDir}`);
  log(`JSON: ${jsonPath}`);
  log(`HTML: ${htmlPath}`);
  return { outDir, jsonPath, htmlPath, report };
}

async function main() {
  await runResearchBenchmarks();
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}

module.exports = {
  runResearchBenchmarks,
};

