const CURRENT_MS = 5 * 60 * 1000;

const workers = new Map();

export function announceWorker({ workerId, name, engines, device, deviceWanted }) {
  if (!workerId) return;

  workers.set(workerId, {
    id: workerId,
    name: name || workerId,
    engines: Array.isArray(engines) && engines.length > 0 ? engines : null,
    device: device || null,
    deviceWanted: deviceWanted || null,
    lastSeen: Date.now()
  });
}

export function touchWorker(workerId) {
  const worker = workers.get(workerId);

  if (worker) worker.lastSeen = Date.now();
}

function knownWorkers() {
  const cutoff = Date.now() - CURRENT_MS;

  for (const [id, worker] of workers) {
    if (worker.lastSeen < cutoff) workers.delete(id);
  }

  return [...workers.values()];
}

export function workerCount() {
  return knownWorkers().length;
}

export function workerCanRender(workerId, engine) {
  const worker = workers.get(workerId);

  if (!worker || worker.engines === null) return true;

  return worker.engines.includes(engine);
}

export function engineIsOffered(engine) {
  const known = knownWorkers();

  if (known.length === 0) return true;

  return known.some(worker => worker.engines === null || worker.engines.includes(engine));
}

export function devicesNotOffered() {
  return knownWorkers()
    .filter(worker => worker.deviceWanted)
    .map(worker => ({
      name: worker.name,
      wanted: worker.deviceWanted,
      device: worker.device
    }));
}

export function machines(claims = []) {
  return knownWorkers().map(worker => {
    const claim = claims.find(held => held.id === worker.id);

    return {
      id: worker.id,
      name: worker.name,
      engines: worker.engines,
      device: worker.device,
      deviceWanted: worker.deviceWanted,
      lastSeen: new Date(worker.lastSeen).toISOString(),
      jobId: claim?.jobId ?? null,
      frame: claim?.frame ?? null
    };
  });
}
