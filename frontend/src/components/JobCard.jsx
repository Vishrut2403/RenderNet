import { useState } from 'react';
import { api } from '../api/client';
import { StatusBadge, ProgressBar, Button, Metrics, relativeTime, formatDuration, useNow } from './ui';

const TONE = { completed: 'done', failed: 'fail', cancelled: 'muted' };

export function JobCard({ job, onChanged, onError }) {
  const [busy, setBusy] = useState(false);
  const [frames, setFrames] = useState(null);
  const [showErrors, setShowErrors] = useState(false);

  const active = job.status === 'rendering';
  const done = job.status === 'completed';

  const now = useNow(active);
  const started = job.startedAt ? new Date(job.startedAt).getTime() : null;
  const finished = job.completedAt ? new Date(job.completedAt).getTime() : null;

  const elapsed = started ? (finished ?? now) - started : null;
  const perFrame = job.completedFrames > 0 && elapsed ? elapsed / job.completedFrames : null;
  const remaining = job.totalFrames - job.completedFrames;

  const timing = active
    ? [
        ['Elapsed', formatDuration(elapsed)],
        ['Per frame', perFrame ? formatDuration(perFrame) : '—'],
        ['Remaining', `${remaining} frame${remaining === 1 ? '' : 's'}`],
        ['ETA', perFrame ? `~${formatDuration(perFrame * remaining)}` : 'estimating']
      ]
    : elapsed !== null && job.completedFrames > 0
      ? [
          ['Total', formatDuration(elapsed)],
          ['Per frame', perFrame ? formatDuration(perFrame) : '—'],
          ['Frames', `${job.completedFrames} / ${job.totalFrames}`],
          ['Engine', job.renderEngine.replace('BLENDER_', '')]
        ]
      : null;

  async function cancel() {
    if (!confirm(`Cancel job ${job.id}? Rendered frames will be deleted.`)) return;

    setBusy(true);
    try {
      await api.cancelJob(job.id);
      onChanged?.();
    } catch (err) {
      onError?.(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function toggleFrames() {
    if (frames) return setFrames(null);

    setBusy(true);
    try {
      const result = await api.jobFiles(job.id);
      setFrames(result.files);
    } catch (err) {
      onError?.(err.message);
    } finally {
      setBusy(false);
    }
  }

  // currentFrame is the last frame finished, so the one in flight is the next.
  const inFlight = Math.min(job.frameEnd, (job.currentFrame ?? job.frameStart - 1) + 1);

  const label = active
    ? `Rendering frame ${inFlight} of ${job.frameEnd}`
    : `${job.completedFrames} of ${job.totalFrames} frames`;

  return (
    <article className={`job job-${job.status}`}>
      <header className="job-head">
        <div>
          <h3 className="job-title">{job.originalFilename || 'Untitled'}</h3>
          <div className="job-sub">
            #{job.id} · {job.renderEngine} · frames {job.frameStart}–{job.frameEnd} ·{' '}
            {relativeTime(job.createdAt)}
            {job.owner && <> · <span className="owner">{job.owner}</span></>}
          </div>
        </div>
        <StatusBadge status={job.status} />
      </header>

      {(active || done || job.completedFrames > 0) && (
        <ProgressBar value={job.progress} label={label} tone={TONE[job.status] || 'active'} />
      )}

      {job.status === 'pending' && (
        <p className="job-note">
          {job.queuePosition ? `Queued — position ${job.queuePosition}` : 'Queued'}
        </p>
      )}

      {timing && <Metrics items={timing} />}

      {job.error && <p className="job-error">{job.error}</p>}

      {job.frameErrors?.length > 0 && (
        <div className="frame-errors">
          <button className="linkish" onClick={() => setShowErrors(v => !v)}>
            {showErrors ? 'Hide' : 'Show'} {job.frameErrors.length} failed frame
            {job.frameErrors.length > 1 ? 's' : ''}
          </button>

          {showErrors && (
            <ul>
              {job.frameErrors.map(entry => (
                <li key={`${entry.frame}-${entry.at}`}>
                  <span className="frame-no">Frame {entry.frame}</span>
                  <code>{entry.error}</code>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {frames && (
        <div className="frame-grid">
          {frames.map(file => (
            <a key={file.filename} href={file.url} target="_blank" rel="noreferrer" title={file.filename}>
              <img src={file.url} alt={file.filename} loading="lazy" />
            </a>
          ))}
        </div>
      )}

      <footer className="job-actions">
        {(job.status === 'pending' || active) && (
          <Button variant="danger" busy={busy} onClick={cancel}>Cancel</Button>
        )}

        {done && (
          <>
            <a className="btn btn-primary" href={api.zipUrl(job.id)}>Download ZIP</a>
            <Button busy={busy} onClick={toggleFrames}>
              {frames ? 'Hide frames' : 'View frames'}
            </Button>
          </>
        )}
      </footer>
    </article>
  );
}
