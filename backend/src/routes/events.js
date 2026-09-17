import express from 'express';
import { whenAnnounced, CHANGED } from '../bus.js';

const router = express.Router();

const BEAT_MS = 20 * 1000;

router.get('/', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  res.flushHeaders?.();

  const send = text => {
    if (res.writableEnded) return;

    res.write(text);
  };

  // No job data on this stream: what a viewer may see is decided by their next request.
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
