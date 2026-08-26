// Who is out there and what they can render. A worker says so every time it
// asks for a frame, so the list needs no registration step and no cleanup: a
// machine that stops asking simply stops being current.
const CURRENT_MS = 5 * 60 * 1000;

const workers = new Map();

export function announceWorker({ workerId, name, engines, device }) {
  if (!workerId) return;

  workers.set(workerId, {
    id: workerId,
    name: name || workerId,
    // A worker that says nothing about its engines is trusted with any of them:
    // refusing it work it may well be able to do would leave the farm idle.
    engines: Array.isArray(engines) && engines.length > 0 ? engines : null,
    device: device || null,
    lastSeen: Date.now()
  });
}

export function knownWorkers() {
  const cutoff = Date.now() - CURRENT_MS;

  for (const [id, worker] of workers) {
    if (worker.lastSeen < cutoff) workers.delete(id);
  }

  return [...workers.values()];
}

export function workerCanRender(workerId, engine) {
  const worker = workers.get(workerId);

  if (!worker || worker.engines === null) return true;

  return worker.engines.includes(engine);
}

// Nobody has to be able to render it right now - a machine may be switched off
// - but if none of the workers that are here can, the job is waiting for one
// that may never arrive, and saying so beats a progress bar that never moves.
export function engineIsOffered(engine) {
  const known = knownWorkers();

  if (known.length === 0) return true;

  return known.some(worker => worker.engines === null || worker.engines.includes(engine));
}

// One row per machine rather than per claim: what it is, what it can render,
// and the frame it happens to be holding.
export function machines(claims = []) {
  return knownWorkers().map(worker => {
    const claim = claims.find(held => held.id === worker.id);

    return {
      id: worker.id,
      name: worker.name,
      engines: worker.engines,
      device: worker.device,
      lastSeen: new Date(worker.lastSeen).toISOString(),
      jobId: claim?.jobId ?? null,
      frame: claim?.frame ?? null
    };
  });
}
