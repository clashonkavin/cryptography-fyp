const fs = require("node:fs");
const path = require("node:path");
const hre = require("hardhat");
const {
  stepDeploy,
  stepCreateTask,
  stepSubmitContractors,
  stepFinalizeTask,
} = require("../../server/simulateSteps");

const DEFAULT_MIN_IMPROVEMENT_PERCENT = Number(process.env.MIN_IMPROVEMENT_PERCENT || "5");
const SCENARIO_FILE = process.env.BENCHMARK_SCENARIOS_FILE
  ? path.resolve(process.env.BENCHMARK_SCENARIOS_FILE)
  : path.join(__dirname, "scenarios.json");

function scenario(name, contractorValues, rewardEth = "0.05") {
  return { name, contractorValues, rewardEth };
}

function buildDefaultScenarios() {
  return [
    scenario("Small majority (5 contractors)", [25, 25, 30, 25, 25]),
    scenario("Large majority (8 contractors)", [25, 25, 25, 30, 25, 25, 40, 25]),
    scenario("Split vote (6 contractors)", [25, 30, 25, 30, 25, 40]),
    scenario("All equal (7 contractors)", [25, 25, 25, 25, 25, 25, 25]),
    scenario("Higher variance (10 contractors)", [99, 99, 99, 17, 42, 99, 31, 99, 17, 99]),
  ];
}

function loadScenarios() {
  if (!fs.existsSync(SCENARIO_FILE)) {
    return buildDefaultScenarios();
  }
  const raw = fs.readFileSync(SCENARIO_FILE, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`Scenario file must be a non-empty JSON array: ${SCENARIO_FILE}`);
  }
  const out = parsed.map((it, idx) => {
    if (!it || typeof it !== "object") throw new Error(`Invalid scenario at index ${idx}`);
    if (typeof it.name !== "string" || !it.name.trim()) {
      throw new Error(`Scenario ${idx} missing non-empty "name"`);
    }
    if (!Array.isArray(it.contractorValues) || it.contractorValues.length === 0) {
      throw new Error(`Scenario ${idx} missing non-empty "contractorValues"`);
    }
    return scenario(
      it.name.trim(),
      it.contractorValues.map((v) => Number(v)),
      it.rewardEth ? String(it.rewardEth) : "0.05"
    );
  });
  return out;
}

function toBigIntSafe(v) {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(v);
  if (typeof v === "string") return BigInt(v);
  throw new Error(`Cannot convert to bigint: ${String(v)}`);
}

function toNumber(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string") return Number(v);
  return null;
}

function fmtInt(n) {
  return Number(n).toLocaleString("en-US");
}

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function writeJson(filePath, obj) {
  fs.writeFileSync(filePath, `${JSON.stringify(obj, null, 2)}\n`, "utf8");
}

function generateMarkdownReport({ filePath, rows, aggregate, minImprovementPercent }) {
  const lines = [];
  lines.push("# Gas Benchmark Report");
  lines.push("");
  lines.push(`- Generated at: \`${new Date().toISOString()}\``);
  lines.push(`- Minimum required improvement: \`${minImprovementPercent}%\``);
  lines.push(`- Passes: \`${aggregate.passedScenarios}/${aggregate.totalScenarios}\``);
  lines.push(`- Mean total-gas improvement: \`${aggregate.meanImprovementPercent.toFixed(2)}%\``);
  lines.push(`- Mean runtime-gas improvement: \`${aggregate.meanRuntimeImprovementPercent.toFixed(2)}%\``);
  lines.push(`- Mean submit-gas improvement: \`${aggregate.meanSubmitImprovementPercent.toFixed(2)}%\``);
  lines.push("");
  lines.push("## Scenario Results");
  lines.push("");
  lines.push("| Scenario | New total gas | Old total gas | Delta (old-new) | Improvement | Pass |");
  lines.push("|---|---:|---:|---:|---:|:---:|");
  for (const row of rows) {
    lines.push(
      `| ${row.name} | ${fmtInt(row.newTotalGas)} | ${fmtInt(row.oldTotalGas)} | ${fmtInt(
        row.deltaGas
      )} | ${row.improvementPercent.toFixed(2)}% | ${row.pass ? "YES" : "NO"} |`
    );
  }
  lines.push("");
  lines.push("| Scenario | New runtime gas | Old runtime gas | Runtime improvement | New submit gas | Old submit gas | Submit improvement |");
  lines.push("|---|---:|---:|---:|---:|---:|---:|");
  for (const row of rows) {
    lines.push(
      `| ${row.name} | ${fmtInt(row.newRuntimeGas)} | ${fmtInt(row.oldRuntimeGas)} | ${row.runtimeImprovementPercent.toFixed(
        2
      )}% | ${fmtInt(row.newSubmitGas)} | ${fmtInt(row.oldSubmitGas)} | ${row.submitImprovementPercent.toFixed(2)}% |`
    );
  }
  lines.push("");
  lines.push("## Per-Tx Mean Gas (all scenarios)");
  lines.push("");
  lines.push("| Metric | New | Old |");
  lines.push("|---|---:|---:|");
  lines.push(`| Deploy | ${fmtInt(aggregate.avgDeployGasNew)} | ${fmtInt(aggregate.avgDeployGasOld)} |`);
  lines.push(
    `| Create task | ${fmtInt(aggregate.avgCreateTaskGasNew)} | ${fmtInt(aggregate.avgCreateTaskGasOld)} |`
  );
  lines.push(`| Submit result | ${fmtInt(aggregate.avgSubmitGasNew)} | ${fmtInt(aggregate.avgSubmitGasOld)} |`);
  lines.push(`| Finalize task | ${fmtInt(aggregate.avgFinalizeGasNew)} | ${fmtInt(aggregate.avgFinalizeGasOld)} |`);
  lines.push("");
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}

function generateHtmlReport({ filePath, rows, aggregate, minImprovementPercent }) {
  const labels = rows.map((r) => r.name);
  const improvements = rows.map((r) => Number(r.improvementPercent.toFixed(2)));
  const deltas = rows.map((r) => Number(r.deltaGas));
  const newTotals = rows.map((r) => Number(r.newTotalGas));
  const oldTotals = rows.map((r) => Number(r.oldTotalGas));

  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Gas Benchmark Report</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
      body { font-family: Arial, sans-serif; margin: 24px; color: #111; }
      .grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); }
      .card { border: 1px solid #ddd; border-radius: 10px; padding: 12px; }
      table { border-collapse: collapse; width: 100%; margin-top: 12px; }
      th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
      th { background: #f6f6f6; }
      .ok { color: #0a7a2f; font-weight: 700; }
      .bad { color: #b91c1c; font-weight: 700; }
    </style>
  </head>
  <body>
    <h1>Gas Benchmark Report</h1>
    <p>Generated at: <code>${new Date().toISOString()}</code></p>
    <p>Minimum required improvement: <code>${minImprovementPercent}%</code></p>
    <p>Passes: <code>${aggregate.passedScenarios}/${aggregate.totalScenarios}</code></p>
    <p>Mean total-gas improvement: <code>${aggregate.meanImprovementPercent.toFixed(2)}%</code></p>
    <p>Mean runtime-gas improvement: <code>${aggregate.meanRuntimeImprovementPercent.toFixed(2)}%</code></p>
    <p>Mean submit-gas improvement: <code>${aggregate.meanSubmitImprovementPercent.toFixed(2)}%</code></p>

    <div class="grid">
      <div class="card"><canvas id="chartImprovement"></canvas></div>
      <div class="card"><canvas id="chartTotals"></canvas></div>
      <div class="card"><canvas id="chartDelta"></canvas></div>
    </div>

    <h2>Scenario Table</h2>
    <table>
      <thead>
        <tr>
          <th>Scenario</th>
          <th>New total gas</th>
          <th>Old total gas</th>
          <th>Delta (old-new)</th>
          <th>Improvement</th>
          <th>Pass</th>
        </tr>
      </thead>
      <tbody>
        ${rows
          .map(
            (r) => `<tr>
            <td>${r.name}</td>
            <td>${fmtInt(r.newTotalGas)}</td>
            <td>${fmtInt(r.oldTotalGas)}</td>
            <td>${fmtInt(r.deltaGas)}</td>
            <td>${r.improvementPercent.toFixed(2)}%</td>
            <td class="${r.pass ? "ok" : "bad"}">${r.pass ? "YES" : "NO"}</td>
          </tr>`
          )
          .join("")}
      </tbody>
    </table>

    <script>
      const labels = ${JSON.stringify(labels)};
      const improvements = ${JSON.stringify(improvements)};
      const deltas = ${JSON.stringify(deltas)};
      const newTotals = ${JSON.stringify(newTotals)};
      const oldTotals = ${JSON.stringify(oldTotals)};
      const minLine = new Array(labels.length).fill(${minImprovementPercent});

      new Chart(document.getElementById("chartImprovement"), {
        type: "bar",
        data: {
          labels,
          datasets: [
            { label: "Improvement %", data: improvements },
            { label: "Minimum %", data: minLine, type: "line" }
          ]
        },
        options: { responsive: true }
      });

      new Chart(document.getElementById("chartTotals"), {
        type: "bar",
        data: {
          labels,
          datasets: [
            { label: "New total gas", data: newTotals },
            { label: "Old total gas", data: oldTotals }
          ]
        },
        options: { responsive: true }
      });

      new Chart(document.getElementById("chartDelta"), {
        type: "bar",
        data: { labels, datasets: [{ label: "Delta gas (old-new)", data: deltas }] },
        options: { responsive: true }
      });
    </script>
  </body>
</html>`;
  fs.writeFileSync(filePath, html, "utf8");
}

async function runScenario({ provider, scenarioItem, maxContractors }) {
  const run = await stepDeploy({ provider, maxContractors });
  const rewardEth = scenarioItem.rewardEth;
  const created = await stepCreateTask({
    provider,
    run,
    description: `Benchmark: ${scenarioItem.name}`,
    rewardEth,
  });

  const submit = await stepSubmitContractors({
    provider,
    run,
    contractorValues: scenarioItem.contractorValues,
  });
  const finalize = await stepFinalizeTask({ provider, run });

  const newTotalGas = toBigIntSafe(finalize.gasComparison.newScheme.totalGas);
  const oldTotalGas = toBigIntSafe(finalize.gasComparison.oldScheme.totalGas);
  const deltaGas = oldTotalGas - newTotalGas;
  const improvementPercent = oldTotalGas > 0n ? (Number(deltaGas) / Number(oldTotalGas)) * 100 : 0;
  const newRuntimeGas = toBigIntSafe(finalize.gasComparison.newScheme.runtimeGas);
  const oldRuntimeGas = toBigIntSafe(finalize.gasComparison.oldScheme.runtimeGas);
  const deltaRuntimeGas = oldRuntimeGas - newRuntimeGas;
  const runtimeImprovementPercent =
    oldRuntimeGas > 0n ? (Number(deltaRuntimeGas) / Number(oldRuntimeGas)) * 100 : 0;
  const newSubmitGas = toBigIntSafe(finalize.gasComparison.newScheme.submitGas);
  const oldSubmitGas = toBigIntSafe(finalize.gasComparison.oldScheme.submitGas);
  const deltaSubmitGas = oldSubmitGas - newSubmitGas;
  const submitImprovementPercent =
    oldSubmitGas > 0n ? (Number(deltaSubmitGas) / Number(oldSubmitGas)) * 100 : 0;

  const finalizeGasNew = toNumber(finalize?.finalizeReceipt?.newScheme?.gasUsed);
  const finalizeGasOld = toNumber(finalize?.finalizeReceipt?.oldScheme?.gasUsed);

  const submitGasNew = submit.submissions
    .map((s) => toNumber(s?.gas?.newScheme?.gasUsed))
    .filter((v) => Number.isFinite(v));
  const submitGasOld = submit.submissions
    .map((s) => toNumber(s?.gas?.oldScheme?.gasUsed))
    .filter((v) => Number.isFinite(v));

  const deployGasNew = toNumber(run?.deployReceipt?.newScheme?.gasUsed);
  const deployGasOld = toNumber(run?.deployReceipt?.oldScheme?.gasUsed);
  const createTaskGasNew = toNumber(created?.createTaskReceipt?.newScheme?.gasUsed);
  const createTaskGasOld = toNumber(created?.createTaskReceipt?.oldScheme?.gasUsed);

  return {
    name: scenarioItem.name,
    contractorCount: scenarioItem.contractorValues.length,
    rewardEth,
    newTotalGas: Number(newTotalGas),
    oldTotalGas: Number(oldTotalGas),
    deltaGas: Number(deltaGas),
    improvementPercent,
    newRuntimeGas: Number(newRuntimeGas),
    oldRuntimeGas: Number(oldRuntimeGas),
    deltaRuntimeGas: Number(deltaRuntimeGas),
    runtimeImprovementPercent,
    newSubmitGas: Number(newSubmitGas),
    oldSubmitGas: Number(oldSubmitGas),
    deltaSubmitGas: Number(deltaSubmitGas),
    submitImprovementPercent,
    deployGasNew,
    deployGasOld,
    createTaskGasNew,
    createTaskGasOld,
    finalizeGasNew,
    finalizeGasOld,
    submitGasNew,
    submitGasOld,
  };
}

function mean(numbers) {
  if (!numbers.length) return 0;
  return numbers.reduce((acc, v) => acc + v, 0) / numbers.length;
}

async function main() {
  const provider = hre.ethers.provider;
  const scenarios = loadScenarios();
  const maxContractors = Math.max(...scenarios.map((s) => s.contractorValues.length));

  console.log(`Running ${scenarios.length} benchmark scenarios...`);
  const rows = [];
  for (let i = 0; i < scenarios.length; i++) {
    const s = scenarios[i];
    console.log(`[${i + 1}/${scenarios.length}] ${s.name}`);
    const row = await runScenario({ provider, scenarioItem: s, maxContractors });
    row.pass =
      row.improvementPercent >= DEFAULT_MIN_IMPROVEMENT_PERCENT &&
      row.runtimeImprovementPercent >= DEFAULT_MIN_IMPROVEMENT_PERCENT &&
      row.submitImprovementPercent >= DEFAULT_MIN_IMPROVEMENT_PERCENT &&
      row.deltaGas > 0 &&
      row.deltaRuntimeGas > 0 &&
      row.deltaSubmitGas > 0;
    rows.push(row);
    console.log(
      `   total ${fmtInt(row.newTotalGas)} -> ${fmtInt(row.oldTotalGas)} (${row.improvementPercent.toFixed(2)}%) ` +
        `runtime ${fmtInt(row.newRuntimeGas)} -> ${fmtInt(row.oldRuntimeGas)} (${row.runtimeImprovementPercent.toFixed(
          2
        )}%) ` +
        `submit ${fmtInt(row.newSubmitGas)} -> ${fmtInt(row.oldSubmitGas)} (${row.submitImprovementPercent.toFixed(
          2
        )}%) ` +
        `${row.pass ? "PASS" : "FAIL"}`
    );
  }

  const aggregate = {
    totalScenarios: rows.length,
    passedScenarios: rows.filter((r) => r.pass).length,
    failedScenarios: rows.filter((r) => !r.pass).length,
    meanImprovementPercent: mean(rows.map((r) => r.improvementPercent)),
    meanRuntimeImprovementPercent: mean(rows.map((r) => r.runtimeImprovementPercent)),
    meanSubmitImprovementPercent: mean(rows.map((r) => r.submitImprovementPercent)),
    avgDeployGasNew: Math.round(mean(rows.map((r) => r.deployGasNew).filter((v) => Number.isFinite(v)))),
    avgDeployGasOld: Math.round(mean(rows.map((r) => r.deployGasOld).filter((v) => Number.isFinite(v)))),
    avgCreateTaskGasNew: Math.round(
      mean(rows.map((r) => r.createTaskGasNew).filter((v) => Number.isFinite(v)))
    ),
    avgCreateTaskGasOld: Math.round(
      mean(rows.map((r) => r.createTaskGasOld).filter((v) => Number.isFinite(v)))
    ),
    avgFinalizeGasNew: Math.round(mean(rows.map((r) => r.finalizeGasNew).filter((v) => Number.isFinite(v)))),
    avgFinalizeGasOld: Math.round(mean(rows.map((r) => r.finalizeGasOld).filter((v) => Number.isFinite(v)))),
    avgSubmitGasNew: Math.round(
      mean(
        rows
          .flatMap((r) => r.submitGasNew)
          .filter((v) => Number.isFinite(v))
      )
    ),
    avgSubmitGasOld: Math.round(
      mean(
        rows
          .flatMap((r) => r.submitGasOld)
          .filter((v) => Number.isFinite(v))
      )
    ),
  };

  const stamp = nowStamp();
  const outDir = path.join(__dirname, "..", "..", "reports", "benchmarks", stamp);
  fs.mkdirSync(outDir, { recursive: true });

  const jsonPath = path.join(outDir, "benchmark-results.json");
  const mdPath = path.join(outDir, "benchmark-report.md");
  const htmlPath = path.join(outDir, "benchmark-report.html");

  const payload = {
    generatedAt: new Date().toISOString(),
    minImprovementPercent: DEFAULT_MIN_IMPROVEMENT_PERCENT,
    aggregate,
    scenarios: rows,
  };
  writeJson(jsonPath, payload);
  generateMarkdownReport({
    filePath: mdPath,
    rows,
    aggregate,
    minImprovementPercent: DEFAULT_MIN_IMPROVEMENT_PERCENT,
  });
  generateHtmlReport({
    filePath: htmlPath,
    rows,
    aggregate,
    minImprovementPercent: DEFAULT_MIN_IMPROVEMENT_PERCENT,
  });

  const allPassed = aggregate.failedScenarios === 0;
  console.log("");
  console.log(`Report directory: ${outDir}`);
  console.log(`JSON report: ${jsonPath}`);
  console.log(`Markdown report: ${mdPath}`);
  console.log(`HTML report: ${htmlPath}`);
  console.log("");
  console.log(
    `Benchmark verdict: ${allPassed ? "PASS" : "FAIL"} ` +
      `(${aggregate.passedScenarios}/${aggregate.totalScenarios} scenarios passed)`
  );
  console.log(
    `Mean improvement: ${aggregate.meanImprovementPercent.toFixed(2)}% ` +
      `(required >= ${DEFAULT_MIN_IMPROVEMENT_PERCENT}%)`
  );

  if (!allPassed) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
