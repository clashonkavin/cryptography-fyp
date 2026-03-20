const { C, ok, info, fail } = require("./ansi");
const { parseEvents } = require("./eventUtils");

module.exports = async function finalizeTaskStep({
  contract,
  taskId,
  clientSigner,
  contractorSigners,
  hre,
  contractorData,
}) {
  // This step prints exactly what the original simulate.js did.
  const balancesBefore = await Promise.all(
    contractorSigners.map((s) => hre.ethers.provider.getBalance(s.address))
  );

  const tx2 = await contract.connect(clientSigner).finalizeTask(taskId);
  const receipt2 = await tx2.wait();

  const events = parseEvents(contract, receipt2.logs);

  const finalizeEvt = events.find((e) => e.name === "TaskFinalized");
  if (finalizeEvt) {
    const winC4hex = Buffer.from(
      finalizeEvt.args.winningC4.slice(2),
      "hex"
    ).toString("hex");
    ok(`Task finalized!`);
    info(
      `Majority count: ${finalizeEvt.args.majorityCount} / ${finalizeEvt.args.totalSubmissions}`
    );
    info(`Winning C4: ${winC4hex.slice(0, 20)}…`);
  }

  const rewardedAddrs = events
    .filter((e) => e.name === "ContractorRewarded")
    .map((e) => e.args.contractor.toLowerCase());

  const rejectedAddrs = events
    .filter((e) => e.name === "ContractorRejected")
    .map((e) => ({
      addr: e.args.contractor.toLowerCase(),
      reason: e.args.reason,
    }));

  console.log("");
  contractorData.forEach((cd, i) => {
    const addr = contractorSigners[i].address.toLowerCase();
    const rewarded = rewardedAddrs.includes(addr);
    const rejected = rejectedAddrs.find((r) => r.addr === addr);

    if (rewarded) {
      ok(`${cd.label} (result=${cd.value}) → ${C.green}REWARDED${C.reset} 🏆`);
    } else if (rejected) {
      fail(
        `${cd.label} (result=${cd.value}) → ${C.red}REJECTED${C.reset} (${rejected.reason})`
      );
    } else {
      fail(
        `${cd.label} (result=${cd.value}) → ${C.red}NOT REWARDED${C.reset} (invalid proof)`
      );
    }
  });

  const balancesAfter = await Promise.all(
    contractorSigners.map((s) => hre.ethers.provider.getBalance(s.address))
  );

  console.log("");
  contractorSigners.forEach((s, i) => {
    const delta = balancesAfter[i] - balancesBefore[i];
    if (delta > 0n) {
      info(`  ETH received by Contractor ${i + 1}: +${hre.ethers.formatEther(delta)} ETH`);
    }
  });
};

