import { useEffect, useRef, useState, useCallback } from 'react';

// Polls while the tab is visible, at whatever interval the caller derives from
// the data.
export function usePolling(fetcher, intervalFor, deps = []) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const timer = useRef(null);
  const cancelled = useRef(false);
  const paused = useRef(false);
  const runId = useRef(0);
  const fetcherRef = useRef(fetcher);
  const intervalRef = useRef(intervalFor);
  const dataRef = useRef(null);

  fetcherRef.current = fetcher;
  intervalRef.current = intervalFor;
  dataRef.current = data;

  const tick = useCallback(async () => {
    // Clearing the timer cannot cancel a request already in flight, and without
    // this both ticks schedule a successor and the loop forks in two.
    const run = ++runId.current;
    const stale = () => cancelled.current || run !== runId.current;

    try {
      const result = await fetcherRef.current();
      if (stale()) return;

      // Set here as well as on the state: the interval below is chosen from
      // what was just fetched, and a render has not happened yet to record it.
      dataRef.current = result;
      setData(result);
      setError(null);
    } catch (err) {
      if (stale()) return;
      if (err.status !== 401) setError(err.message);
    } finally {
      if (!stale()) {
        setLoading(false);

        if (!paused.current) {
          const delay = typeof intervalRef.current === 'function'
            ? intervalRef.current(dataRef.current)
            : intervalRef.current;

          timer.current = setTimeout(tick, delay);
        }
      }
    }
  }, []);

  const refresh = useCallback(() => {
    clearTimeout(timer.current);
    tick();
  }, [tick]);

  useEffect(() => {
    cancelled.current = false;
    paused.current = false;
    tick();

    const onVisibility = () => {
      paused.current = document.visibilityState !== 'visible';

      if (paused.current) clearTimeout(timer.current);
      else refresh();
    };

    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled.current = true;
      clearTimeout(timer.current);
      document.removeEventListener('visibilitychange', onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, error, loading, refresh, setData };
}

// A job actively rendering is worth watching closely; anything else is not.
export function jobsInterval(jobs) {
  const active = (jobs || []).some(job => job.status === 'rendering');
  return active ? 2000 : 10000;
}
