// One credential per machine that renders, rather than one secret shared by all
// of them: a machine that is lost or retired can be shut out on its own.
import crypto from 'crypto';
import os from 'os';
import {
  insertWorkerToken, workerTokenByHash, listWorkerTokens, getWorkerToken,
  revokeWorkerToken, touchWorkerToken, deleteLocalWorkerTokens
} from './db.js';

const TOUCH_EVERY_MS = 60 * 1000;
const lastTouched = new Map();

function digest(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function mintWorkerToken({ name, createdBy, isLocal = false }) {
  const token = crypto.randomBytes(32).toString('hex');
  const id = crypto.randomBytes(8).toString('hex');

  insertWorkerToken({
    id,
    name,
    tokenHash: digest(token),
    createdAt: new Date().toISOString(),
    createdBy,
    isLocal: isLocal ? 1 : 0
  });

  return { id, name, token };
}

// The token is high-entropy, so its digest is enough of a lookup key; a slow
// hash here would run on every frame request a worker makes.
export function machineFor(token) {
  if (typeof token !== 'string' || token.length === 0) return null;

  const machine = workerTokenByHash(digest(token));

  if (!machine) return null;

  const now = Date.now();

  if (now - (lastTouched.get(machine.id) ?? 0) > TOUCH_EVERY_MS) {
    lastTouched.set(machine.id, now);
    touchWorkerToken(machine.id);
  }

  return { id: machine.id, name: machine.name, isLocal: machine.isLocal === 1 };
}

export function listMachines() {
  return listWorkerTokens().map(row => ({
    id: row.id,
    name: row.name,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
    lastSeen: row.lastSeen,
    revokedAt: row.revokedAt,
    isLocal: row.isLocal === 1
  }));
}

export function revokeMachine(id) {
  const machine = getWorkerToken(id);

  if (!machine) return { success: false, status: 404, error: 'No such machine' };

  if (machine.isLocal === 1) {
    return {
      success: false,
      status: 400,
      error: 'This workstation renders with a credential it mints at every boot'
    };
  }

  if (!revokeWorkerToken(id)) {
    return { success: false, status: 409, error: 'That machine was already revoked' };
  }

  return { success: true, name: machine.name };
}

// Minted fresh at boot and handed to the workers this server starts, so the
// machine it runs on needs nothing configured and leaves nothing reusable
// behind when it stops.
let local = null;

export function localMachineToken() {
  if (!local) {
    deleteLocalWorkerTokens();
    local = mintWorkerToken({
      name: `${os.hostname()} (this workstation)`,
      createdBy: 'server',
      isLocal: true
    });
  }

  return local.token;
}

// A farm upgrading from the single shared secret keeps working: the value it
// already has becomes an ordinary machine credential, visible in the admin list
// and revocable once every worker has one of its own.
export function importSharedSecret() {
  const shared = process.env.WORKER_SECRET;

  if (!shared || workerTokenByHash(digest(shared))) return null;

  const id = crypto.randomBytes(8).toString('hex');

  insertWorkerToken({
    id,
    name: 'Shared WORKER_SECRET',
    tokenHash: digest(shared),
    createdAt: new Date().toISOString(),
    createdBy: 'environment',
    isLocal: 0
  });

  return id;
}
