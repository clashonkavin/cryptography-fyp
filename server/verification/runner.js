const vm = require("node:vm");
const { performance } = require("node:perf_hooks");
const { VERIFIER_REGISTRY } = require("./registry");

function deepValidateValue(x) {
  if (x === null) return true;
  if (typeof x === "number") return Number.isFinite(x);
  if (typeof x === "string" || typeof x === "boolean") return true;
  if (Array.isArray(x)) return x.every(deepValidateValue);
  if (typeof x === "object") return Object.values(x).every(deepValidateValue);
  return false;
}

function runBuiltinVerifier(verifierId, instance, witness) {
  const entry = VERIFIER_REGISTRY[verifierId];
  if (!entry) throw new Error(`Unknown verifierId: ${verifierId}`);
  const t0 = performance.now();
  const valid = Boolean(entry.verify(instance, witness));
  const t1 = performance.now();
  return {
    mode: "builtin",
    verifierId,
    verifierName: entry.name,
    valid,
    runtimeMs: t1 - t0,
  };
}

function runCustomJsVerifier(code, instance, witness) {
  if (!code || typeof code !== "string") {
    throw new Error("Custom JS verifier code is required");
  }
  const wrapped = `
    "use strict";
    ${code}
    if (typeof verify !== "function") {
      throw new Error("Custom verifier must export function verify(instance, witness)");
    }
    verify;
  `;
  const context = vm.createContext({
    Math,
    Number,
    Boolean,
    String,
    Array,
    Object,
    JSON,
  });
  const script = new vm.Script(wrapped, { timeout: 250 });
  const verifyFn = script.runInContext(context, { timeout: 250 });
  const t0 = performance.now();
  const valid = Boolean(verifyFn(instance, witness));
  const t1 = performance.now();
  return {
    mode: "custom-js",
    valid,
    runtimeMs: t1 - t0,
  };
}

function runCustomAnswerJsVerifier(code, answerArray) {
  if (!Array.isArray(answerArray)) {
    throw new Error("Answer must be an array");
  }
  if (!deepValidateValue(answerArray)) {
    throw new Error("Answer array contains unsupported data type");
  }
  if (!code || typeof code !== "string") {
    throw new Error("Custom answer verifier code is required");
  }
  const wrapped = `
    "use strict";
    ${code}
    if (typeof verifyAnswer !== "function") {
      throw new Error("Custom answer verifier must define verifyAnswer(answerArray)");
    }
    verifyAnswer;
  `;
  const context = vm.createContext({
    Math,
    Number,
    Boolean,
    String,
    Array,
    Object,
    JSON,
  });
  const script = new vm.Script(wrapped, { timeout: 250 });
  const verifyFn = script.runInContext(context, { timeout: 250 });
  const t0 = performance.now();
  const valid = Boolean(verifyFn(answerArray));
  const t1 = performance.now();
  return {
    mode: "custom-answer-js",
    valid,
    runtimeMs: t1 - t0,
  };
}

function runVerifierProgram({ mode, verifierId, code, instance, witness }) {
  if (!deepValidateValue(instance) || !deepValidateValue(witness)) {
    throw new Error("Inputs contain unsupported data type");
  }
  if (mode === "builtin") return runBuiltinVerifier(verifierId, instance, witness);
  if (mode === "custom-js") return runCustomJsVerifier(code, instance, witness);
  if (mode === "custom-answer-js") return runCustomAnswerJsVerifier(code, witness);
  throw new Error("Unsupported verifier mode. Use 'builtin' or 'custom-js'.");
}

module.exports = {
  runVerifierProgram,
  VERIFIER_REGISTRY,
};

