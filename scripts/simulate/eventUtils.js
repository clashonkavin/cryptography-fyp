function parseEvents(contract, logs) {
  return logs
    .map((log) => {
      try {
        return contract.interface.parseLog(log);
      } catch (_) {
        return null;
      }
    })
    .filter(Boolean);
}

function findEventByName(contract, logs, eventName) {
  const events = parseEvents(contract, logs);
  return events.find((e) => e && e.name === eventName) || null;
}

module.exports = { parseEvents, findEventByName };

