import { useEffect, useRef } from 'react';
import { streamEvents } from '../api/client';

// Reconnection backs off so a farm that is down is not hammered by every open
// tab, and starts again from the bottom once a connection has held.
const FIRST_RETRY_MS = 1000;
const LONGEST_RETRY_MS = 30 * 1000;

// Tells the caller when something on the farm moved, and keeps `live` true only
// while that is actually working - the pollers slow down when it is and go back
// to their old pace when it is not, so a lost stream costs freshness, not
// updates.
export function useLiveUpdates(live, onChange) {
  const handler = useRef(onChange);

  handler.current = onChange;

  useEffect(() => {
    const stop = new AbortController();
    let retry = FIRST_RETRY_MS;
    let timer = null;
    let running = true;

    const connect = async () => {
      try {
        await streamEvents(stop.signal, () => {
          // Only once a message has arrived: headers alone do not prove that
          // anything is reaching us.
          live.current = true;
          retry = FIRST_RETRY_MS;
          handler.current?.();
        });
      } catch {
        // Nothing to show: the pollers carry on either way.
      }

      live.current = false;

      if (!running) return;

      timer = setTimeout(connect, retry);
      retry = Math.min(retry * 2, LONGEST_RETRY_MS);
    };

    connect();

    return () => {
      running = false;
      live.current = false;
      clearTimeout(timer);
      stop.abort();
    };
  }, [live]);
}
