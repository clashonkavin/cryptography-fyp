const { ok, info, bold } = require("./ansi");

module.exports = async function deployContractStep(hre) {
  const accounts = await hre.ethers.getSigners();
  const clientSigner = accounts[0];
  const contractorSigners = accounts.slice(1, 6); // 5 contractors

  const Factory = await hre.ethers.getContractFactory("OutsourcedComputation");
  const contract = await Factory.deploy();
  await contract.waitForDeployment();

  const addr = await contract.getAddress();
  ok(`OutsourcedComputation deployed at ${bold(addr)}`);
  info(`Client:       ${clientSigner.address}`);
  contractorSigners.forEach((s, i) => info(`Contractor ${i + 1}: ${s.address}`));

  return { contract, clientSigner, contractorSigners };
};

