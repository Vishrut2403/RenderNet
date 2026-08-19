import { useMemo, useState } from 'react';
import { api } from '../api/client';
import { usePolling, jobsInterval } from '../hooks/usePolling';
import { useJobFinished } from '../hooks/useJobFinished';
import { JobCard } from '../components/JobCard';
import { Alert, EmptyState } from '../components/ui';

const FILTERS = ['all', 'rendering', 'pending', 'completed', 'failed', 'cancelled'];

export function Jobs({ notify }) {
  const [filter, setFilter] = useState('all');

  const { data, error, loading, refresh } = usePolling(
    api.jobs,
    result => jobsInterval(result?.jobs)
  );

  const jobs = useMemo(
    () => [...(data?.jobs || [])].sort((a, b) => b.id - a.id),
    [data]
  );

  useJobFinished(data?.jobs);

  const counts = useMemo(() => {
    const tally = { all: jobs.length };
    for (const job of jobs) tally[job.status] = (tally[job.status] || 0) + 1;
    return tally;
  }, [jobs]);

  const visible = filter === 'all' ? jobs : jobs.filter(job => job.status === filter);

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

      {visible.length === 0 ? (
        <EmptyState title={jobs.length ? `No ${filter} jobs` : 'No renders yet'}>
          {jobs.length ? 'Try a different filter.' : 'Upload a .blend file to queue your first render.'}
        </EmptyState>
      ) : (
        visible.map(job => (
          <JobCard
            key={job.id}
            job={job}
            onChanged={refresh}
            onError={message => notify(message, 'error')}
          />
        ))
      )}
    </div>
  );
}
