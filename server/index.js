const path = require("node:path");
const crypto = require("node:crypto");
const express = require("express");
const { ethers } = require("ethers");

const { ensureHardhatNode } = require("./hardhatNode");
const {
  stepDeploy,
  stepCreateTask,
  stepSubmitContractors,
  stepFinalizeTask,
  stepDecrypt,
} = require("./simulateSteps");

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const HARDHAT_PORT = process.env.HARDHAT_PORT ? Number(process.env.HARDHAT_PORT) : 8545;
const RPC_URL =
  process.env.RPC_URL || `http://127.0.0.1:${String(HARDHAT_PORT)}`;

async function main() {
  await ensureHardhatNode({ port: HARDHAT_PORT, cwd: path.join(__dirname, "..") });

  const provider = new ethers.JsonRpcProvider(RPC_URL);

  const app = express();
  app.use(express.json({ limit: "1mb" }));

  // Serve UI
  app.use(express.static(path.join(__dirname, "public")));

  let activeRun = null;

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, rpcUrl: RPC_URL });
  });

  app.post("/api/deploy", async (req, res) => {
    try {
      // For demo: one run at a time (reset any old state).
      activeRun = null;
      const run = await stepDeploy({ provider, maxContractors: 10 });
      activeRun = run;
      res.json({ runId: run.runId, ...runForUI(run) });
    } catch (err) {
      res.status(500).json({ error: String(err?.message || err) });
    }
  });

  app.post("/api/createTask", async (req, res) => {
    try {
      if (!activeRun) throw new Error("Deploy contract first");
      const { runId, description, rewardEth } = req.body || {};
      if (runId && activeRun.runId !== runId) throw new Error("Invalid runId");

      const out = await stepCreateTask({
        provider,
        run: activeRun,
        description,
        rewardEth,
      });
      res.json({ runId: activeRun.runId, ...out });
    } catch (err) {
      res.status(500).json({ error: String(err?.message || err) });
    }
  });

  app.post("/api/submitContractors", async (req, res) => {
    try {
      if (!activeRun) throw new Error("Deploy and createTask first");
      const { runId, numberOfContractors, contractorValues } = req.body || {};

      if (runId && activeRun.runId !== runId) throw new Error("Invalid runId");

      if (!Array.isArray(contractorValues)) {
        throw new Error("contractorValues must be an array");
      }

      const values = contractorValues.slice(0, Number(numberOfContractors || contractorValues.length));
      const out = await stepSubmitContractors({
        provider,
        run: activeRun,
        contractorValues: values,
      });

      activeRun.contractorValues = values;
      activeRun.contractorCount = values.length;
      res.json({ runId: activeRun.runId, ...out });
    } catch (err) {
      res.status(500).json({ error: String(err?.message || err) });
    }
  });

  app.post("/api/finalizeTask", async (req, res) => {
    try {
      if (!activeRun) throw new Error("Deploy and createTask first");
      const { runId } = req.body || {};
      if (runId && activeRun.runId !== runId) throw new Error("Invalid runId");

      // store contractor values (optional if UI changed)
      if (!activeRun.contractorValues) activeRun.contractorValues = [];

      const out = await stepFinalizeTask({ provider, run: activeRun });
      res.json({ runId: activeRun.runId, ...out });
    } catch (err) {
      res.status(500).json({ error: String(err?.message || err) });
    }
  });

  app.post("/api/decrypt", async (req, res) => {
    try {
      if (!activeRun) throw new Error("Deploy and createTask first");
      const { runId } = req.body || {};
      if (runId && activeRun.runId !== runId) throw new Error("Invalid runId");
      const out = await stepDecrypt({ provider, run: activeRun });
      res.json({ runId: activeRun.runId, ...out });
    } catch (err) {
      res.status(500).json({ error: String(err?.message || err) });
    }
  });

  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`UI server running at http://127.0.0.1:${PORT}`);
  });
}

function runForUI(run) {
  return {
    contractAddress: run.contractAddress,
    contractAddresses: run.contractAddresses,
    clientAddress: run.clientAddress,
    contractorAddresses: run.contractorAddresses,
    deployReceipt: run.deployReceipt,
  };
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exitCode = 1;
});

