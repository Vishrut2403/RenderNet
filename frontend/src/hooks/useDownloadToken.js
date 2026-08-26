import { useEffect, useState } from 'react';
import { api } from '../api/client';

const RENEW_MARGIN_MS = 60 * 1000;

// Fetched while the card has something to download and renewed before it runs
// out, so a job still rendering an hour later keeps showing its latest frame.
export function useDownloadToken(jobId, enabled) {
  const [token, setToken] = useState(null);

  useEffect(() => {
    if (!enabled) return;

    let live = true;
    let timer = null;

    const fetchToken = async () => {
      try {
        const minted = await api.downloadToken(jobId);

        if (!live) return;

        setToken(minted.token);
        timer = setTimeout(fetchToken, Math.max(minted.expiresAt - Date.now() - RENEW_MARGIN_MS, 30000));
      } catch {
        // Nothing to show the user: the links simply do not appear, and the
        // next poll of the job list mounts this again.
      }
    };

    fetchToken();

    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [jobId, enabled]);

  return token;
}
