import { useEffect, useRef } from 'react';

const FINISHED = ['completed', 'failed'];

export function notificationsAvailable() {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function askToNotify() {
  if (!notificationsAvailable() || Notification.permission !== 'default') return;
  Notification.requestPermission();
}

function describe(job) {
  if (job.status === 'completed') {
    return `${job.completedFrames} frame${job.completedFrames === 1 ? '' : 's'} rendered`;
  }

  return job.error || 'Render failed';
}

export function useJobFinished(jobs) {
  const previous = useRef(null);

  useEffect(() => {
    if (!jobs) return;

    const seen = previous.current;
    previous.current = new Map(jobs.map(job => [job.id, job.status]));

    if (!seen) return;
    if (!notificationsAvailable() || Notification.permission !== 'granted') return;

    for (const job of jobs) {
      const before = seen.get(job.id);

      if (before === undefined || before === job.status) continue;
      if (!FINISHED.includes(job.status)) continue;

      new Notification(`${job.originalFilename || `Job ${job.id}`} ${job.status}`, {
        body: describe(job),
        tag: `rendernet-job-${job.id}`
      });
    }
  }, [jobs]);
}
