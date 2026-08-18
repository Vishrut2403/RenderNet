import { useEffect, useState } from 'react';

export function StatusBadge({ status }) {
  return <span className={`badge badge-${status}`}>{status}</span>;
}

export function ProgressBar({ value, label, tone = 'active' }) {
  const pct = Math.max(0, Math.min(100, value || 0));

  return (
    <div className="progress">
      <div className="progress-track">
        <div className={`progress-fill progress-${tone}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="progress-meta">
        <span>{label}</span>
        <span className="progress-pct">{pct}%</span>
      </div>
    </div>
  );
}

export function Button({ variant = 'secondary', busy, children, ...rest }) {
  return (
    <button className={`btn btn-${variant}`} disabled={busy || rest.disabled} {...rest}>
      {busy ? 'Working…' : children}
    </button>
  );
}

export function Field({ label, hint, ...rest }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <input {...rest} />
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function Alert({ kind = 'error', children }) {
  if (!children) return null;
  return <div className={`alert alert-${kind}`}>{children}</div>;
}

export function EmptyState({ title, children }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children && <p>{children}</p>}
    </div>
  );
}

export function Modal({ title, onClose, children }) {
  useEffect(() => {
    const onKey = event => event.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

export function Toast({ toast, onDismiss }) {
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(onDismiss, 5000);
    return () => clearTimeout(timer);
  }, [toast, onDismiss]);

  if (!toast) return null;

  return (
    <div className={`toast toast-${toast.kind}`} onClick={onDismiss} role="status">
      {toast.message}
    </div>
  );
}

// Ticks once a second while active so elapsed times count up between polls.
export function useNow(active) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);

  return now;
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';

  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;

  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function Metrics({ items }) {
  return (
    <dl className="metrics">
      {items.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function relativeTime(iso) {
  if (!iso) return '—';

  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);

  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}
