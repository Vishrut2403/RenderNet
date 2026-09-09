// What the farm shouts across itself: a worker has finished a frame, a job has
// work to give out. Nothing durable goes through here - SQLite remains the
// record of what is true, and this only says that it has changed, so a message
// that never arrives costs a wait rather than a frame.
//
// With REDIS_URL set that shout reaches every server process; without it, this
// process only. One process is the ordinary case and needs no Redis, which is
// why the local path is not a degraded mode but the default.
import { EventEmitter } from 'events';
import { createClient } from 'redis';

const CHANNEL = 'rendernet';

// The farm has something claimable. Deliberately not which job: whoever is
// waiting asks the queue, which is the only thing that decides who gets it.
export const WORK = 'work';

// Something about a job moved. Like WORK it carries nothing: a browser is told
// to look again, and what it may see is decided when it asks, not here.
export const CHANGED = 'changed';

const local = new EventEmitter();
// Every waiting worker adds one, and a busy farm can hold a lot of them.
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

// Said once: a farm that cannot reach Redis still renders, and repeating it for
// every frame would bury what it is rendering.
function trouble(what, error) {
  if (complained) return;

  complained = true;
  console.warn(`Redis ${what} (${error.message}). Carrying on without it: `
    + 'workers wait out their poll instead of being told.');
}

// Bounded on purpose. Left to itself the client retries the first connection
// for ever, which turns "Redis is not there" from a warning into a farm that
// hangs waiting for one - and the farm works perfectly well without it.
const CONNECT_MS = 2000;
const ATTEMPTS = 3;

async function connect(role) {
  const client = createClient({
    url: url(),
    socket: {
      connectTimeout: CONNECT_MS,
      reconnectStrategy: attempts =>
        (attempts > ATTEMPTS ? false : Math.min(attempts * 200, CONNECT_MS))
    }
  });

  client.on('error', error => trouble(`${role} connection failed`, error));
  await client.connect();

  return client;
}

// Called once at startup. Failing to reach Redis is not fatal: the farm falls
// back to the local emitter, which is what it would have used anyway.
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
        // Somebody else's message on our channel; not ours to understand.
      }
    });

    console.log(`Redis at ${url()}: workers are told when there is work`);
  } catch (error) {
    trouble('could not be reached', error);
    await stopBus();
  }

  return busIsShared();
}

// Bounded, because this sits in the Ctrl+C path: quit() waits for Redis to
// answer, and a Redis that has stopped answering must not be what keeps the
// farm from exiting. Dropped outright once the moment for manners has passed.
export async function stopBus() {
  const open = [publisher, subscriber].filter(Boolean);

  publisher = null;
  subscriber = null;

  const goodbye = Promise.all(open.map(client => client.quit().catch(() => {})));
  const patience = new Promise(resolve => setTimeout(resolve, 1000).unref?.());

  await Promise.race([goodbye, patience]);

  for (const client of open) {
    try {
      client.destroy();
    } catch {
      // Already gone, which is the outcome either way.
    }
  }
}

// Fire and forget in both senses: the caller does not wait for it, and a Redis
// that has gone away must not fail the render that was announcing itself.
export function announce(name, detail = null) {
  if (!publisher) return local.emit(name, detail);

  publisher.publish(CHANNEL, JSON.stringify({ name, detail }))
    .catch(error => trouble('publish failed', error));

  // Not through Redis for this process: its own subscriber would deliver it a
  // moment later, and a worker held here should not wait for the round trip.
  return local.emit(name, detail);
}

// A job record is written every time a frame lands, which on a fast render is
// several a second. Browsers only need to know that something moved, so these
// are gathered up and sent as one.
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

// Resolves true if the event arrives before the deadline, false if it does not.
// The timer is unrefed so a pending wait cannot hold the process open, and an
// aborted wait lets go of its listener rather than leaving it until the timeout:
// the caller that gave up is usually a worker whose connection has just died.
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
