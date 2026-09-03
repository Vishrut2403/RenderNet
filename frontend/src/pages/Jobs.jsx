import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import { usePolling, jobsInterval } from '../hooks/usePolling';
import { useJobFinished } from '../hooks/useJobFinished';
import { JobCard } from '../components/JobCard';
import { Alert, EmptyState } from '../components/ui';

const FILTERS = ['all', 'rendering', 'pending', 'completed', 'failed', 'cancelled'];
const PAGE = 25;

export function Jobs({ notify }) {
  const [filter, setFilter] = useState('all');
  const [older, setOlder] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const newest = useCallback(() => api.jobs({ status: filter, limit: PAGE }), [filter]);

  const { data, error, loading, refresh } = usePolling(
    newest,
    result => jobsInterval(result?.jobs),
    [filter]
  );

  useEffect(() => {
    setOlder([]);
    setCursor(null);
  }, [filter]);

  useJobFinished(data?.jobs);

  // Only the newest page is polled; the pages behind it hold jobs that have
  // long since stopped changing.
  const jobs = useMemo(() => {
    const page = data?.jobs ?? [];
    const shown = new Set(page.map(job => job.id));

    return [...page, ...older.filter(job => !shown.has(job.id))];
  }, [data, older]);

  const counts = data?.counts ?? {};
  const nextBefore = older.length > 0 ? cursor : data?.nextBefore ?? null;

  const loadMore = async () => {
    setLoadingMore(true);

    try {
      const page = await api.jobs({ status: filter, before: nextBefore, limit: PAGE });

      setOlder(current => [...current, ...page.jobs]);
      setCursor(page.nextBefore);
    } catch (failure) {
      notify(failure.message, 'error');
    } finally {
      setLoadingMore(false);
    }
  };

  if (loading) return <div className="panel">Loading jobs…</div>;

  return (
    <div className="stack">
      <Alert>{error}</Alert>

      <div className="tabs tabs-filter">
        {FILTERS.map(name => (
          <button
            key={name}
            className={filter === name ? 'active' : ''}
            onClick={() => setFilter(name)}
            disabled={name !== 'all' && !counts[name]}
          >
            {name}
            {counts[name] ? <span className="count">{counts[name]}</span> : null}
          </button>
        ))}
      </div>

      {jobs.length === 0 ? (
        <EmptyState title={counts.all ? `No ${filter} jobs` : 'No renders yet'}>
          {counts.all ? 'Try a different filter.' : 'Upload a .blend file to queue your first render.'}
        </EmptyState>
      ) : (
        jobs.map(job => (
          <JobCard
            key={job.id}
            job={job}
            onChanged={refresh}
            onError={message => notify(message, 'error')}
          />
        ))
      )}

      {nextBefore && (
        <button className="btn" onClick={loadMore} disabled={loadingMore}>
          {loadingMore ? 'Loading…' : `Show older (${jobs.length} of ${counts[filter] ?? counts.all})`}
        </button>
      )}
    </div>
  );
}
