const $ = (id) => document.getElementById(id);

/** Plurality of values; on ties, smallest first-occurrence index wins (matches on-chain finalize). */
function pluralityFromValues(values) {
  if (!values || values.length === 0) return null;
  const firstIdx = new Map();
  const counts = new Map();
  for (let i = 0; i < values.length; i++) {
    const v = Number(values[i]);
    if (!Number.isFinite(v)) continue;
    if (!counts.has(v)) {
      firstIdx.set(v, i);
      counts.set(v, 0);
    }
    counts.set(v, counts.get(v) + 1);
  }
  if (counts.size === 0) return null;
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

const els = {
  banner: $("banner"),
  btnDeploy: $("btnDeploy"),
  deployOut: $("deployOut"),

  description: $("description"),
  rewardEth: $("rewardEth"),
  btnCreateTask: $("btnCreateTask"),
  createTaskOut: $("createTaskOut"),

  numContractors: $("numContractors"),
  contractorInputs: $("contractorInputs"),
  contractorPlurality: $("contractorPlurality"),
  contractorTableBody: $("contractorTableBody"),
  btnSubmit: $("btnSubmit"),
  submitOut: $("submitOut"),

  btnFinalize: $("btnFinalize"),
  finalizeOut: $("finalizeOut"),
  gasComparePanel: $("gasComparePanel"),
  gasNewTotal: $("gasNewTotal"),
  gasOldTotal: $("gasOldTotal"),
  gasDelta: $("gasDelta"),
  gasRatio: $("gasRatio"),

  btnDecrypt: $("btnDecrypt"),
  decryptOut: $("decryptOut"),
};

const DEFAULT_CONTRACTOR_VALUE = 0;

let state = {
  runId: null,
  contractorValues: [],
  submissions: null,
  finalize: null,
  decrypted: null,
};

function setBanner(msg, kind = "info") {
  els.banner.textContent = msg;
  els.banner.classList.toggle("banner--error", kind === "error");
}

function pill(text, ok) {
  const cls = ok ? "pill ok" : "pill bad";
  return `<span class="${cls}">${text}</span>`;
}

function formatTable(rows) {
  if (!rows || rows.length === 0) return "(empty)";
  const headers = Object.keys(rows[0]);
  const ths = headers.map((h) => `<th>${h}</th>`).join("");
  const trs = rows
    .map((r) => {
      return `<tr>${headers
        .map((h) => `<td>${r[h] ?? ""}</td>`)
        .join("")}</tr>`;
    })
    .join("");
  return `<table><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table>`;
}

function postJson(url, body) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).then(async (r) => {
    const data = await r.json().catch(() => null);
    if (!r.ok) {
      throw new Error(data?.error || `Request failed (${r.status})`);
    }
    return data;
  });
}

function setDisabled() {
  const deployed = !!state.runId;
  const created = !!state.finalize || !!state.decrypted || !!els.createTaskOut.dataset.taskId;
  const submitted = !!state.submissions;

  els.btnCreateTask.disabled = !deployed;
  els.btnSubmit.disabled = !deployed || !created;
  els.btnFinalize.disabled = !deployed || !created || !submitted;
  els.btnDecrypt.disabled = !deployed || !created || !els.btnFinalize.disabled && !state.finalize ? false : false;

  // A better gate for decrypt:
  els.btnDecrypt.disabled = !state.finalize;
}

function updatePluralityPreview() {
  const n = Number(els.numContractors.value || 0);
  const values = state.contractorValues.slice(0, n);
  let plurality = pluralityFromValues(values);
  let pluralityLabel = "Plurality among values below";
  if (state.submissions && state.submissions.length >= n) {
    const verifiedOnly = values.filter((_, i) => state.submissions[i]?.onChainProofValid);
    if (verifiedOnly.length > 0) {
      plurality = pluralityFromValues(verifiedOnly);
      pluralityLabel = "Plurality among verified on-chain submissions";
    }
  }
  const p = els.contractorPlurality;
  if (!plurality) {
    p.textContent = "";
    p.hidden = true;
    return;
  }
  p.hidden = false;
  p.textContent = "";
  const lead = document.createTextNode(`${pluralityLabel}: `);
  const strong = document.createElement("strong");
  strong.textContent = String(plurality.value);
  const tail = document.createTextNode(
    ` (${plurality.count} vote${plurality.count === 1 ? "" : "s"}).`
  );
  p.append(lead, strong, tail);
}

/** Rebuilds contractor rows only when the row count changes; typing updates state + plurality only. */
function renderContractorInputs() {
  const n = Number(els.numContractors.value || 0);

  state.contractorValues = Array.from(
    { length: n },
    (_, i) => state.contractorValues[i] ?? DEFAULT_CONTRACTOR_VALUE
  );

  const tb = els.contractorTableBody;
  tb.replaceChildren();

  for (let i = 0; i < n; i++) {
    const tr = document.createElement("tr");
    const tdNum = document.createElement("td");
    tdNum.textContent = String(i + 1);
    const tdVal = document.createElement("td");
    const inp = document.createElement("input");
    inp.type = "number";
    inp.className = "cValue";
    inp.dataset.idx = String(i);
    inp.value = String(state.contractorValues[i]);
    tdVal.appendChild(inp);
    tr.appendChild(tdNum);
    tr.appendChild(tdVal);
    tb.appendChild(tr);
  }

  updatePluralityPreview();
}

els.contractorInputs.addEventListener("input", (e) => {
  const t = e.target;
  if (!(t instanceof HTMLInputElement) || !t.classList.contains("cValue")) return;
  const idx = Number(t.dataset.idx);
  if (!Number.isFinite(idx)) return;
  const raw = t.value.trim();
  state.contractorValues[idx] = raw === "" ? NaN : Number(raw);
  updatePluralityPreview();
});

function resetStepOutputs() {
  els.deployOut.textContent = "";
  els.createTaskOut.textContent = "";
  els.submitOut.textContent = "";
  els.finalizeOut.textContent = "";
  els.decryptOut.textContent = "";
  els.contractorTableBody.replaceChildren();
  els.contractorPlurality.textContent = "";
  els.contractorPlurality.hidden = true;
  if (els.gasComparePanel) els.gasComparePanel.hidden = true;
  if (els.gasNewTotal) els.gasNewTotal.textContent = "-";
  if (els.gasOldTotal) els.gasOldTotal.textContent = "-";
  if (els.gasDelta) els.gasDelta.textContent = "-";
  if (els.gasRatio) els.gasRatio.textContent = "-";
  state.contractorValues = [];
}

els.btnDeploy.addEventListener("click", async () => {
  try {
    els.btnDeploy.disabled = true;
    setBanner("Deploying contract on local Hardhat...");
    resetStepOutputs();
    els.btnDeploy.textContent = "Deploying...";
    const out = await postJson("/api/deploy", {});
    state.runId = out.runId;
    renderContractorInputs();

    els.deployOut.textContent = JSON.stringify(out, null, 2);
    setBanner("Contract deployed. Continue to Step 2.", "info");
    setDisabled();
  } catch (err) {
    setBanner(String(err.message || err), "error");
  } finally {
    els.btnDeploy.disabled = false;
    els.btnDeploy.textContent = "Deploy";
    setDisabled();
  }
});

els.btnCreateTask.addEventListener("click", async () => {
  try {
    const description = els.description.value.trim();
    const rewardEth = els.rewardEth.value;

    els.btnCreateTask.disabled = true;
    setBanner("Creating task (client deposits reward)...");

    const out = await postJson("/api/createTask", {
      runId: state.runId,
      description,
      rewardEth,
    });

    // store taskId in DOM dataset for gating
    els.createTaskOut.dataset.taskId = out.taskId;
    els.createTaskOut.textContent = JSON.stringify(out, null, 2);

    renderContractorInputs();

    setBanner("Task created. Continue to Step 3.", "info");
    setDisabled();
  } catch (err) {
    setBanner(String(err.message || err), "error");
  } finally {
    els.btnCreateTask.disabled = false;
    setDisabled();
  }
});

els.numContractors.addEventListener("input", () => {
  // don't allow changes after submissions (keep it simple)
  if (state.submissions) return;
  renderContractorInputs();
  setDisabled();
});

els.btnSubmit.addEventListener("click", async () => {
  try {
    els.btnSubmit.disabled = true;
    setBanner("Submitting results from all contractors...");

    const n = Number(els.numContractors.value);
    const contractorValues = state.contractorValues.slice(0, n).map((x) =>
      Number.isFinite(Number(x)) ? Number(x) : DEFAULT_CONTRACTOR_VALUE
    );

    const out = await postJson("/api/submitContractors", {
      runId: state.runId,
      numberOfContractors: n,
      contractorValues,
    });

    state.submissions = out.submissions;

    // add readability layer for UI
    const rows = state.submissions.map((s) => ({
      Contractor: s.contractorIndex,
      Address: s.contractorAddress.slice(0, 10) + "...",
      Value: s.submittedValue,
      OffchainProofValid: s.offChainProofValid ? "true" : "false",
      OnchainProofValidNew: s.onChainProofValid ? "true" : "false",
      OnchainProofValidOld: s.onChainProofValidOld ? "true" : "false",
      GasCostETH_New: s.gas.newScheme?.gasCostEth ?? "",
      GasCostETH_Old: s.gas.oldScheme?.gasCostEth ?? "",
      BalanceDeltaETH: s.balanceDeltaEth,
      C3: s.debug.C3,
      TxHash: (s.submitTxHash || "").slice(0, 14) + "...",
    }));

    els.submitOut.innerHTML =
      `<div class="pill">${pill("Submitted", true).replace("pill ok", "pill")}</div>` +
      `<pre style="white-space:pre-wrap;color:inherit;margin-top:10px;">${JSON.stringify(
        { submissions: rows },
        null,
        2
      )}</pre>`;

    renderContractorInputs();
    setBanner("Submissions complete. Continue to Step 4.", "info");
    setDisabled();
  } catch (err) {
    setBanner(String(err.message || err), "error");
  } finally {
    els.btnSubmit.disabled = false;
    setDisabled();
  }
});

els.btnFinalize.addEventListener("click", async () => {
  try {
    els.btnFinalize.disabled = true;
    setBanner("Finalizing task on-chain (majority vote + transfers)...");

    const out = await postJson("/api/finalizeTask", { runId: state.runId });
    state.finalize = out;

    const contractorRows = out.contractors.map((c) => ({
      Contractor: c.contractorIndex,
      Address: c.contractorAddress.slice(0, 10) + "...",
      Rewarded: c.rewarded ? "Yes" : "No",
      Reason: c.rewarded ? "" : c.rejectReason,
      TransferDeltaETH: c.transferDeltaEth,
      RewardAmountETH: c.rewardAmountEth ?? "",
    }));

    const cmp = out.gasComparison || {};
    const newTotal = cmp?.newScheme?.totalGas ?? "-";
    const oldTotal = cmp?.oldScheme?.totalGas ?? "-";
    const delta = cmp?.deltaGas ?? "-";
    const ratio =
      typeof cmp?.ratioOldToNew === "number" ? `${cmp.ratioOldToNew.toFixed(4)}x` : "-";
    const fmt = (v) => (typeof v === "string" ? Number(v).toLocaleString("en-US") : String(v));
    if (els.gasComparePanel) els.gasComparePanel.hidden = false;
    if (els.gasNewTotal) els.gasNewTotal.textContent = fmt(newTotal);
    if (els.gasOldTotal) els.gasOldTotal.textContent = fmt(oldTotal);
    if (els.gasDelta) els.gasDelta.textContent = fmt(delta);
    if (els.gasRatio) els.gasRatio.textContent = ratio;

    els.finalizeOut.innerHTML =
      `<pre style="white-space:pre-wrap;color:inherit;margin-top:10px;">${JSON.stringify(
        {
          majorityCount: out.majorityCount,
          totalSubmissions: out.totalSubmissions,
          finalizeReceipt: out.finalizeReceipt,
          winningC3: out.winningC3,
          gasComparison: out.gasComparison,
          contractBalanceDeltaEth: out.contractBalanceDeltaEth,
          contractors: contractorRows,
        },
        null,
        2
      )}</pre>`;

    els.btnDecrypt.disabled = false;
    setBanner("Finalize complete. Continue to Step 5.", "info");
    setDisabled();
  } catch (err) {
    setBanner(String(err.message || err), "error");
  } finally {
    els.btnFinalize.disabled = false;
    setDisabled();
  }
});

els.btnDecrypt.addEventListener("click", async () => {
  try {
    els.btnDecrypt.disabled = true;
    setBanner("Decrypting winning ciphertext off-chain (no gas)...");

    const out = await postJson("/api/decrypt", { runId: state.runId });
    state.decrypted = out;
    els.decryptOut.textContent = JSON.stringify(out, null, 2);
    const ok = out.matchesMajority;
    if (ok === null) {
      setBanner("Decryption finished (could not compare to contractor plurality).", "info");
    } else {
      setBanner(
        ok ? "Decrypted value matches contractor plurality (majority)." : "Decrypted value does NOT match contractor plurality.",
        ok ? "info" : "error"
      );
    }
    setDisabled();
  } catch (err) {
    setBanner(String(err.message || err), "error");
  } finally {
    els.btnDecrypt.disabled = false;
    setDisabled();
  }
});

// initial render / gating
renderContractorInputs();
setDisabled();

