import { useEffect, useRef, useState, useCallback } from 'react';

// Polls while the tab is visible, at whatever interval the caller derives from
// the data. Callers pass a faster interval while a render is active and a slow
// one when the queue is idle, so an idle dashboard costs almost nothing.
export function usePolling(fetcher, intervalFor, deps = []) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const timer = useRef(null);
  const cancelled = useRef(false);
  const fetcherRef = useRef(fetcher);
  const intervalRef = useRef(intervalFor);
  const dataRef = useRef(null);

  fetcherRef.current = fetcher;
  intervalRef.current = intervalFor;
  dataRef.current = data;

  const tick = useCallback(async () => {
    try {
      const result = await fetcherRef.current();
      if (cancelled.current) return;

      setData(result);
      setError(null);
    } catch (err) {
      if (cancelled.current) return;
      if (err.status !== 401) setError(err.message);
    } finally {
      if (cancelled.current) return;

      setLoading(false);

      const delay = typeof intervalRef.current === 'function'
        ? intervalRef.current(dataRef.current)
        : intervalRef.current;

      timer.current = setTimeout(tick, delay);
    }
  }, []);

  const refresh = useCallback(() => {
    clearTimeout(timer.current);
    tick();
  }, [tick]);

  useEffect(() => {
    cancelled.current = false;
    tick();

    const onVisibility = () => {
      if (document.visibilityState === 'visible') refresh();
      else clearTimeout(timer.current);
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
