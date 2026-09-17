import { EventEmitter } from 'events';
import { createClient } from 'redis';

const CHANNEL = 'rendernet';

export const WORK = 'work';

export const CHANGED = 'changed';

const local = new EventEmitter();
local.setMaxListeners(0);

let publisher = null;
let subscriber = null;
let complained = false;

function url() {
  return (process.env.REDIS_URL || '').trim();
}

export function busIsShared() {
  return publisher !== null;
}

function trouble(what, error) {
  if (complained) return;

  complained = true;
  console.warn(`Redis ${what} (${error.message}). Carrying on without it: `
    + 'workers wait out their poll instead of being told.');
}

const CONNECT_MS = 2000;
const ATTEMPTS = 3;
const LONGEST_RETRY_MS = 5000;

async function connect(role) {
  let connected = false;

  const client = createClient({
    url: url(),
    socket: {
      connectTimeout: CONNECT_MS,
      // Give up only before the first connection; after that Redis is restarting.
      reconnectStrategy: attempts => (!connected && attempts > ATTEMPTS
        ? false
        : Math.min(attempts * 200, LONGEST_RETRY_MS))
    }
  });

  client.on('error', error => trouble(`${role} connection failed`, error));

  client.on('ready', () => {
    if (!connected || !complained) return;

    complained = false;
    console.log('Redis is back: workers are told when there is work again');
  });

  await client.connect();
  connected = true;

  return client;
}

export async function startBus() {
  if (!url() || publisher) return busIsShared();

  try {
    publisher = await connect('publisher');
    subscriber = await connect('subscriber');

    await subscriber.subscribe(CHANNEL, message => {
      try {
        const { name, detail } = JSON.parse(message);
        local.emit(name, detail);
      } catch {
      }
    });

    console.log(`Redis at ${url()}: workers are told when there is work`);
  } catch (error) {
    trouble('could not be reached', error);
    await stopBus();
  }

  return busIsShared();
}

export async function stopBus() {
  const open = [publisher, subscriber].filter(Boolean);

  publisher = null;
  subscriber = null;

  // Bounded: this is on the Ctrl+C path, and quit() waits on Redis.
  const goodbye = Promise.all(open.map(client => client.quit().catch(() => {})));
  const patience = new Promise(resolve => setTimeout(resolve, 1000).unref?.());

  await Promise.race([goodbye, patience]);

  for (const client of open) {
    try {
      client.destroy();
    } catch {
    }
  }
}

export function announce(name, detail = null) {
  if (!publisher) return local.emit(name, detail);

  publisher.publish(CHANNEL, JSON.stringify({ name, detail }))
    .catch(error => trouble('publish failed', error));

  return local.emit(name, detail);
}

let gathering = null;

export function announceChanged() {
  if (gathering) return;

  gathering = setTimeout(() => {
    gathering = null;
    announce(CHANGED);
  }, 200);

  gathering.unref?.();
}

export function whenAnnounced(name, handler) {
  local.on(name, handler);

  return () => local.off(name, handler);
}

export function waitFor(name, ms, signal = null) {
  return new Promise(resolve => {
    const done = arrived => {
      clearTimeout(timer);
      local.off(name, onEvent);
      signal?.removeEventListener('abort', onGiveUp);
      resolve(arrived);
    };

    const onEvent = () => done(true);
    const onGiveUp = () => done(false);
    const timer = setTimeout(onGiveUp, ms);

    timer.unref?.();
    local.on(name, onEvent);
    signal?.addEventListener('abort', onGiveUp, { once: true });
  });
}
