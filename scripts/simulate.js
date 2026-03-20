const { runSimulation } = require("./simulate/runSimulation");

runSimulation().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
