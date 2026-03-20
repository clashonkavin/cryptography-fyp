// ── ANSI colour helpers (shared by simulation step modules) ────────────────

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  magenta: "\x1b[35m",
  blue: "\x1b[34m",
  grey: "\x1b[90m",
};

const banner = (msg) =>
  console.log(
    `\n${C.bold}${C.cyan}${"═".repeat(60)}${C.reset}\n${C.bold}${C.cyan}  ${msg}${C.reset}\n${C.bold}${C.cyan}${"═".repeat(60)}${C.reset}`
  );

const section = (msg) =>
  console.log(
    `\n${C.bold}${C.blue}── ${msg} ${"─".repeat(Math.max(0, 56 - msg.length))}${C.reset}`
  );

const ok = (msg) => console.log(`  ${C.green}✔${C.reset}  ${msg}`);
const fail = (msg) => console.log(`  ${C.red}✘${C.reset}  ${msg}`);
const info = (msg) => console.log(`  ${C.grey}ℹ${C.reset}  ${msg}`);
const bold = (msg) => `${C.bold}${msg}${C.reset}`;

module.exports = { C, banner, section, ok, fail, info, bold };

