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
              <span>{worker.id}</span>
              <span className="queue-pos">frame {worker.frame}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Dashboard({ notify }) {
  const jobsPoll = usePolling(api.jobs, result => jobsInterval(result?.jobs));
  const queuePoll = usePolling(api.queueStatus, result => (result?.isRendering ? 2000 : 10000));
  const healthPoll = usePolling(api.health, () => 15000);

  const jobs = jobsPoll.data?.jobs || [];
  const queue = queuePoll.data;
  const problems = healthPoll.data?.problems ?? [];

  useJobFinished(jobsPoll.data?.jobs);
  const usage = jobsPoll.data?.usage;

  const tally = jobs.reduce((acc, job) => {
    acc[job.status] = (acc[job.status] || 0) + 1;
    return acc;
  }, {});

  const rendering = jobs.filter(job => job.status === 'rendering');
  const recent = [...jobs].sort((a, b) => b.id - a.id).slice(0, 3);
  const framesRendered = jobs.reduce((sum, job) => sum + (job.completedFrames || 0), 0);

  const now = useNow(rendering.length > 0);
  const workers = queue?.workers ?? [];
  const elsewhere = Math.max((queue?.activeJobs?.length ?? 0) - rendering.length, 0);
  const otherJobs = `${elsewhere} other job${elsewhere === 1 ? '' : 's'}`;

  const finished = jobs.filter(job => job.status === 'completed' && job.startedAt && job.completedAt);
  const totalRenderMs = finished.reduce(
    (sum, job) => sum + (new Date(job.completedAt) - new Date(job.startedAt)),
    0
  );

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
        <Stat label="Total jobs" value={jobs.length} />
        <Stat label="Rendering" value={tally.rendering || 0} tone="active" />
        <Stat label="Queued" value={queue?.queueLength ?? 0} />
        <Stat label="Completed" value={tally.completed || 0} tone="done" />
        <Stat label="Failed" value={tally.failed || 0} tone="fail" />
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
              onChanged={jobsPoll.refresh}
              onError={message => notify(message, 'error')}
            />
          ))
        )}
      </section>
    </div>
  );
}
