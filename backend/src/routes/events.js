// The page is told to look again, never told what changed. What somebody may
// see depends on who they are, and that is decided by the request they make
// next - so nothing about a job travels down this stream.
import express from 'express';
import { whenAnnounced, CHANGED } from '../bus.js';

const router = express.Router();

// Long enough to be cheap, short enough that anything between here and the
// browser does not decide the connection is dead and drop it.
const BEAT_MS = 20 * 1000;

router.get('/', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Nothing here buffers, but a proxy in front would, and a buffered stream
    // arrives all at once at the end, which is no stream at all.
    'X-Accel-Buffering': 'no'
  });

  res.flushHeaders?.();

  const send = text => {
    if (res.writableEnded) return;

    res.write(text);
  };

  // Said on arrival: a page that opened while something was happening has
  // already missed the announcement about it.
  send('data: changed\n\n');

  const stop = whenAnnounced(CHANGED, () => send('data: changed\n\n'));
  const beat = setInterval(() => send(': beat\n\n'), BEAT_MS);

  beat.unref?.();

  res.on('close', () => {
    stop();
    clearInterval(beat);
  });
});

export default router;
