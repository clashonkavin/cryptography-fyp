const { ok, info, bold } = require("./ansi");
const { findEventByName } = require("./eventUtils");

module.exports = async function createTaskStep({
  contract,
  clientSigner,
  hre,
  generateKeyPair,
  rewardEth,
  description,
}) {
  const clientKeys = generateKeyPair();
  ok(`Client secret key (hex): ${clientKeys.sk.toString(16).slice(0, 16)}…`);
  ok(`Client public key (compressed): ${clientKeys.pkBytes.toString("hex").slice(0, 16)}…`);

  const rewardWei = hre.ethers.parseEther(rewardEth);

  const tx1 = await contract
    .connect(clientSigner)
    .createTask(description, rewardWei, { value: rewardWei });
  const receipt1 = await tx1.wait();

  const taskCreatedEvent = findEventByName(contract, receipt1.logs, "TaskCreated");
  const taskId = taskCreatedEvent ? taskCreatedEvent.args.taskId : 1n;

  ok(`Task #${taskId} created: "${description}"`);
  ok(`Reward deposited: ${rewardEth} ETH`);

  // Keep these fields so later steps do not recompute/guess.
  return { clientKeys, taskId, rewardWei, rewardEth, description };
};

