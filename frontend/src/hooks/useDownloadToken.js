import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';

const RENEW_MARGIN_MS = 60 * 1000;

export function useDownloadToken(jobId, enabled) {
  const [token, setToken] = useState(null);
  const held = useRef(null);

  const mint = useCallback(async () => {
    const minted = await api.downloadToken(jobId);

    held.current = minted;
    setToken(minted.token);

    return minted.token;
  }, [jobId]);

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
