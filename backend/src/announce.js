import os from 'os';
import makeResponder from 'multicast-dns';

// A name of its own on the network, so nobody has to be told an address that
// changes whenever the router feels like it. The client types this; the
// workstation's own hostname is left alone.
const NAME = `${(process.env.FARM_NAME || 'rendernet').toLowerCase()}.local`;
const TTL_SECONDS = 120;

function sameNetwork(here, there) {
  const asBytes = address => address.split('.').map(Number);
  const [ours, theirs, mask] = [asBytes(here.address), asBytes(there), asBytes(here.netmask)];

  return ours.every((byte, at) => (byte & mask[at]) === (theirs[at] & mask[at]));
}

// The machine has several addresses - a wired one, a wireless one, whatever
// Docker and a VPN have added - and only the one on the asker's own network is
// any use to them.
function addressesFor(asker) {
  const here = Object.values(os.networkInterfaces()).flat()
    .filter(entry => entry && entry.family === 'IPv4' && !entry.internal);

  const near = here.filter(entry => sameNetwork(entry, asker));

  return (near.length > 0 ? near : here).map(entry => entry.address);
}

export function announceOnNetwork(port) {
  let responder;

  try {
    responder = makeResponder();
  } catch (error) {
    console.warn(`Not announcing ${NAME}: ${error.message}`);
    return () => {};
  }

  // Never worth stopping the farm for: the address still works.
  responder.on('error', error => console.warn(`${NAME} announcement: ${error.message}`));

  responder.on('query', (query, asker) => {
    const wanted = query.questions.some(question =>
      question.name?.toLowerCase() === NAME && (question.type === 'A' || question.type === 'ANY'));

    if (!wanted) return;

    const answers = addressesFor(asker.address).map(address => ({
      name: NAME, type: 'A', ttl: TTL_SECONDS, data: address
    }));

    if (answers.length > 0) responder.respond({ answers });
  });

  console.log(`    Name:  http://${NAME}:${port}`);

  return () => responder.destroy();
}
