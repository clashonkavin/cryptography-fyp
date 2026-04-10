function isNumber(x) {
  return typeof x === "number" && Number.isFinite(x);
}

function isInt(x) {
  return Number.isInteger(x);
}

function validateNumericArray(arr) {
  return Array.isArray(arr) && arr.every(isNumber);
}

function verifySubsetSum(instance, witness) {
  const values = instance?.values;
  const target = instance?.target;
  if (!validateNumericArray(values) || !isNumber(target) || !Array.isArray(witness)) return false;
  if (!witness.every((idx) => isInt(idx) && idx >= 0 && idx < values.length)) return false;
  const sum = witness.reduce((acc, idx) => acc + values[idx], 0);
  return Math.abs(sum - target) < 1e-9;
}

function evalClause(clause, assignment) {
  if (!Array.isArray(clause)) return false;
  for (const lit of clause) {
    if (!isInt(lit) || lit === 0) return false;
    const variable = Math.abs(lit);
    const val = assignment[String(variable)];
    if (typeof val !== "boolean") return false;
    if ((lit > 0 && val) || (lit < 0 && !val)) return true;
  }
  return false;
}

function verifyThreeSat(instance, witness) {
  const clauses = instance?.clauses;
  if (!Array.isArray(clauses) || typeof witness !== "object" || witness === null) return false;
  return clauses.every((clause) => evalClause(clause, witness));
}

function verifyHamiltonianCycle(instance, witness) {
  const n = instance?.n;
  const edges = instance?.edges;
  const cycle = witness?.cycle;
  if (!isInt(n) || n <= 1 || !Array.isArray(edges) || !Array.isArray(cycle)) return false;
  if (cycle.length !== n + 1) return false;
  if (cycle[0] !== cycle[cycle.length - 1]) return false;
  const visited = new Set(cycle.slice(0, -1));
  if (visited.size !== n) return false;
  const edgeSet = new Set(
    edges
      .filter((e) => Array.isArray(e) && e.length === 2 && isInt(e[0]) && isInt(e[1]))
      .map(([a, b]) => `${a}-${b}`)
  );
  for (let i = 0; i < cycle.length - 1; i++) {
    const a = cycle[i];
    const b = cycle[i + 1];
    if (!edgeSet.has(`${a}-${b}`) && !edgeSet.has(`${b}-${a}`)) return false;
  }
  return true;
}

function verifyGraphColoring(instance, witness) {
  const n = instance?.n;
  const k = instance?.k;
  const edges = instance?.edges;
  const coloring = witness?.coloring;
  if (!isInt(n) || n <= 0 || !isInt(k) || k <= 0) return false;
  if (!Array.isArray(edges) || !Array.isArray(coloring)) return false;
  if (coloring.length !== n) return false;
  if (!coloring.every((c) => isInt(c) && c >= 0 && c < k)) return false;
  for (const e of edges) {
    if (!Array.isArray(e) || e.length !== 2) return false;
    const [u, v] = e;
    if (!isInt(u) || !isInt(v) || u < 0 || v < 0 || u >= n || v >= n) return false;
    if (u === v) return false;
    if (coloring[u] === coloring[v]) return false;
  }
  return true;
}

const VERIFIER_REGISTRY = {
  subset_sum: {
    name: "Subset Sum (NP-complete)",
    inputShape: {
      instance: { values: "number[]", target: "number" },
      witness: "number[] (indices)",
    },
    verify: verifySubsetSum,
  },
  three_sat: {
    name: "3-SAT (NP-complete)",
    inputShape: {
      instance: { clauses: "number[][] (CNF literals)" },
      witness: "Record<varId:boolean>",
    },
    verify: verifyThreeSat,
  },
  hamiltonian_cycle: {
    name: "Hamiltonian Cycle (NP-complete)",
    inputShape: {
      instance: { n: "number", edges: "number[][]" },
      witness: { cycle: "number[]" },
    },
    verify: verifyHamiltonianCycle,
  },
  graph_coloring: {
    name: "Graph Coloring / k-Coloring (NP-complete decision form)",
    inputShape: {
      instance: { n: "number", k: "number", edges: "number[][]" },
      witness: { coloring: "number[] (length n, each in [0, k-1])" },
    },
    verify: verifyGraphColoring,
  },
};

module.exports = {
  VERIFIER_REGISTRY,
};

