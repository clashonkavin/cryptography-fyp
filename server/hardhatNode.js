const { spawn } = require("node:child_process");
const net = require("node:net");

async function isPortOpen(port, host = "127.0.0.1") {
  return await new Promise((resolve) => {
    const socket = net.createConnection({ port, host }, () => {
      socket.end();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
  });
}

async function waitForPort(port, { timeoutMs = 30000 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    // eslint-disable-next-line no-await-in-loop
    if (await isPortOpen(port)) return true;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

async function ensureHardhatNode({ port = 8545, cwd }) {
  if (await isPortOpen(port)) return;

  const child = spawn("npx", ["hardhat", "node", "--port", String(port)], {
    cwd,
    stdio: "ignore",
  });

  // Best-effort: if node takes too long, throw so user knows.
  const ok = await waitForPort(port, { timeoutMs: 60000 });
  if (!ok) {
    child.kill("SIGKILL");
    throw new Error(`Hardhat node failed to start on port ${port}`);
  }
}

module.exports = { ensureHardhatNode };

