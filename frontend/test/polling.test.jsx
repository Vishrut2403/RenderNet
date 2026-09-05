// How often the pages ask the server for more. The interval is derived from
// what came back, so a job that has just started rendering has to be watched
// closely from the next poll rather than the one after it.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { usePolling } from '../src/hooks/usePolling';

afterEach(() => vi.useRealTimers());

describe('usePolling', () => {
  it('chooses the next interval from what was just fetched', async () => {
    const seen = [];
    const fetcher = vi.fn().mockResolvedValue({ status: 'rendering' });

    renderHook(() => usePolling(fetcher, data => {
      seen.push(data);
      return 60000;
    }, []));

    await waitFor(() => expect(seen.length).toBeGreaterThan(0));

    expect(seen[0]).toEqual({ status: 'rendering' });
  });

  it('polls again after the interval it chose', async () => {
    const fetcher = vi.fn().mockResolvedValue([{ status: 'rendering' }]);

    renderHook(() => usePolling(fetcher, () => 20, []));

    await waitFor(() => expect(fetcher.mock.calls.length).toBeGreaterThan(1));
  });
});
