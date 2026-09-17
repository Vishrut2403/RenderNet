import { useEffect, useRef } from 'react';
import { streamEvents } from '../api/client';

const FIRST_RETRY_MS = 1000;
const LONGEST_RETRY_MS = 30 * 1000;

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
          live.current = true;
          retry = FIRST_RETRY_MS;
          handler.current?.();
        });
      } catch {
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
