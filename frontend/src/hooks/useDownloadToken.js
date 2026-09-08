import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';

const RENEW_MARGIN_MS = 60 * 1000;

// A download token lasts minutes, and the timer that renews it does not run
// while the tab is in the background - browsers throttle it, and a laptop that
// slept did not run it at all. So it is renewed on the way back as well, and
// again at the moment somebody actually asks for a file: a link that was drawn
// half an hour ago carries a token that expired long before the click.
export function useDownloadToken(jobId, enabled) {
  const [token, setToken] = useState(null);
  const held = useRef(null);

  const mint = useCallback(async () => {
    const minted = await api.downloadToken(jobId);

    held.current = minted;
    setToken(minted.token);

    return minted.token;
  }, [jobId]);

  // Returns one that will still be valid when the browser gets round to using
  // it, minting only when what we hold is close to running out.
  const fresh = useCallback(async () => {
    const usable = held.current
      && held.current.expiresAt - Date.now() > RENEW_MARGIN_MS;

    return usable ? held.current.token : mint();
  }, [mint]);

  useEffect(() => {
    if (!enabled) return;

    let live = true;
    let timer = null;

    const renew = async () => {
      try {
        await mint();

        if (!live) return;

        const left = (held.current?.expiresAt ?? 0) - Date.now() - RENEW_MARGIN_MS;
        timer = setTimeout(renew, Math.max(left, 30000));
      } catch {
        // Nothing to show the user: the links simply do not appear, and the
        // next poll of the job list mounts this again.
      }
    };

    const onReturn = () => {
      if (document.visibilityState === 'visible') renew();
    };

    renew();
    document.addEventListener('visibilitychange', onReturn);

    return () => {
      live = false;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onReturn);
    };
  }, [enabled, mint]);

  return { token, fresh };
}
