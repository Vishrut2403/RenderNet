import { useMemo } from 'react';
import { api } from '../api/client';
import { usePolling, jobsInterval } from '../hooks/usePolling';
import { useJobFinished } from '../hooks/useJobFinished';
import { JobCard } from '../components/JobCard';
import { EmptyState, ProgressBar, StatusBadge, Metrics, formatDuration, formatBytes, useNow } from '../components/ui';

function Stat({ label, value, tone }) {
  return (
    <div className={`stat ${tone ? `stat-${tone}` : ''}`}>
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}

function ActiveJob({ job, now, workers }) {
  const elapsed = job.startedAt ? now - new Date(job.startedAt).getTime() : null;
  const perFrame = job.timing?.medianMs
    ?? (job.completedFrames > 0 && elapsed ? elapsed / job.completedFrames : null);
  const holders = workers.filter(worker => worker.jobId === job.id);

  return (
    <div className="active-job">
      <div className="worker-line">
        <strong>{job.originalFilename}</strong>
        <StatusBadge status="rendering" />
      </div>
      <ProgressBar
        value={job.progress}
        label={`Rendering frame ${Math.min(
          job.frameEnd,
          (job.currentFrame ?? job.frameStart - 1) + 1
        )} of ${job.frameEnd}`}
      />
      <Metrics
        items={[
          ['Elapsed', formatDuration(elapsed)],
          ['Per frame', perFrame ? formatDuration(perFrame) : '—'],
          ['Engine', job.renderEngine.replace('BLENDER_', '')],
          ['ETA', perFrame
            ? `~${formatDuration(perFrame * (job.totalFrames - job.completedFrames))}`
            : 'estimating']
        ]}
      />
      {holders.length > 0 && (
        <ul className="holders">
          {holders.map(worker => (
            <li key={`${worker.id}:${worker.frame}`}>
              <span>{worker.name || worker.id}</span>
              <span className="queue-pos">frame {worker.frame}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Dashboard({ notify }) {
  // One request for what this page shows rather than every job the user has:
  // the totals are counted server-side, so the payload does not grow with them.
  const summaryPoll = usePolling(api.jobsSummary, result => jobsInterval(result?.rendering));
  const queuePoll = usePolling(api.queueStatus, result => (result?.isRendering ? 2000 : 10000));
  const healthPoll = usePolling(api.health, () => 15000);

  const summary = summaryPoll.data;
  const queue = queuePoll.data;
  const problems = healthPoll.data?.problems ?? [];

  const counts = summary?.counts ?? {};
  const rendering = useMemo(() => summary?.rendering ?? [], [summary]);
  const recent = useMemo(() => summary?.recent ?? [], [summary]);
  const watched = useMemo(() => [...rendering, ...recent], [rendering, recent]);

  useJobFinished(summary ? watched : null);

  const usage = summary?.usage;
  const framesRendered = summary?.framesRendered ?? 0;

  const now = useNow(rendering.length > 0);
  const workers = queue?.workers ?? [];
  const elsewhere = Math.max((queue?.activeJobs?.length ?? 0) - rendering.length, 0);
  const otherJobs = `${elsewhere} other job${elsewhere === 1 ? '' : 's'}`;

  const totalRenderMs = summary?.renderMs ?? 0;

  return (
    <div className="stack">
      {problems.length > 0 && (
        <section className="panel problems">
          <h2 className="panel-title">The farm is not fully working</h2>
          <ul>
            {problems.map(problem => <li key={problem}>{problem}</li>)}
          </ul>
        </section>
      )}

      <div className="stats">
        <Stat label="Total jobs" value={counts.all ?? 0} />
        <Stat label="Rendering" value={counts.rendering || 0} tone="active" />
        <Stat label="Queued" value={queue?.queueLength ?? 0} />
        <Stat label="Completed" value={counts.completed || 0} tone="done" />
        <Stat label="Failed" value={counts.failed || 0} tone="fail" />
        <Stat label="Frames rendered" value={framesRendered} />
        <Stat label="Render time" value={totalRenderMs ? formatDuration(totalRenderMs) : '—'} />
      </div>

      {usage && (
        <section className="panel">
          <h2 className="panel-title">Your space</h2>
          <ProgressBar
            value={Math.round((usage.bytes / usage.quota) * 100)}
            label={`${formatBytes(usage.bytes)} of ${formatBytes(usage.quota)} used`}
            tone={usage.remaining === 0 ? 'fail' : 'active'}
          />
          <p className="idle">
            {usage.remaining === 0
              ? 'Full — delete a finished job before uploading another.'
              : `${formatBytes(usage.remaining)} free. Delete finished jobs once you have downloaded them.`}
          </p>
        </section>
      )}

      <section className="panel">
        <h2 className="panel-title">Workers</h2>

        {rendering.length > 0
          ? rendering.map(job => (
            <ActiveJob key={job.id} job={job} now={now} workers={workers} />
          ))
          : (
            <p className="idle">
              {elsewhere > 0 ? `Busy with ${otherJobs}` : 'Idle — no render in progress'}
            </p>
          )}

        {rendering.length > 0 && elsewhere > 0 && (
          <p className="idle">Also rendering {otherJobs}.</p>
        )}

        {queue?.queue?.length > 0 && (
          <ol className="queue-list">
            {queue.queue.map((entry, index) => (
              <li key={entry.id}>
                <span className="queue-pos">{index + 1}</span>
                <span>{entry.filename || `Job ${entry.id}`}</span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="stack">
        <h2 className="section-label">Recent</h2>

        {recent.length === 0 ? (
          <EmptyState title="Nothing rendered yet">
            Your most recent jobs will appear here.
          </EmptyState>
        ) : (
          recent.map(job => (
            <JobCard
              key={job.id}
              job={job}
              onChanged={summaryPoll.refresh}
              onError={message => notify(message, 'error')}
            />
          ))
        )}
      </section>
    </div>
  );
}
