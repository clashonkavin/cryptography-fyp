const { ok, fail, info, bold, C } = require("./ansi");

module.exports = async function decryptWinningResultStep({
  contract,
  taskId,
  clientKeys,
  decrypt,
}) {
  const [winC1bytes, winC2bytes, _winC3bytes] = await contract.getWinningCiphertext(taskId);

  const C1buf = Buffer.from(winC1bytes.slice(2), "hex");
  const C2buf = Buffer.from(winC2bytes.slice(2), "hex");

  info(`Winning C1: ${C1buf.toString("hex").slice(0, 20)}…`);
  info(`Winning C2: ${C2buf.toString("hex").slice(0, 20)}…`);

  // Decrypt: M_point = C2 - sk_d * C1
  const result = decrypt(
    C1buf,
    C2buf,
    clientKeys.sk,
    Array.from({ length: 200 }, (_, i) => i)
  );

  if (result !== null) {
    console.log(`\n  ${C.bold}${C.green}╔══════════════════════════════════════╗${C.reset}`);
    console.log(
      `  ${C.bold}${C.green}║  Decrypted result: ${String(result).padEnd(17)} ║${C.reset}`
    );
    console.log(`  ${C.bold}${C.green}╚══════════════════════════════════════╝${C.reset}`);
    ok(`square(5) = ${bold(String(result))}  ← correct!`);
  } else {
    fail("Decryption failed – result not in search space");
  }

  return result;
};

