import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { Alert, Button, Field, Modal, relativeTime, formatBytes } from '../components/ui';

export function ChangePasswordModal({ onClose, notify, forced = false, onChanged }) {
  const [oldPassword, setOld] = useState('');
  const [newPassword, setNew] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setError('');

    if (newPassword !== confirm) return setError('New passwords do not match');
    if (newPassword.length < 6) return setError('New password must be at least 6 characters');

    setBusy(true);
    try {
      await api.changePassword(oldPassword, newPassword);
      notify('Password changed', 'success');
      onChanged?.();
      if (!forced) onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Change password" onClose={onClose} dismissible={!forced}>
      {forced && (
        <p className="modal-note">
          This account is still on the password it was given. Choose your own before
          you can queue renders.
        </p>
      )}

      <form onSubmit={submit}>
        <Field label="Current password" type="password" value={oldPassword}
          onChange={e => setOld(e.target.value)} autoComplete="current-password" required />
        <Field label="New password" type="password" value={newPassword}
          onChange={e => setNew(e.target.value)} autoComplete="new-password" required />
        <Field label="Confirm new password" type="password" value={confirm}
          onChange={e => setConfirm(e.target.value)} autoComplete="new-password" required />

        <Alert>{error}</Alert>

        <Button type="submit" variant="primary" busy={busy}>Update password</Button>
      </form>
    </Modal>
  );
}

export function AdminModal({ onClose, notify }) {
  const [users, setUsers] = useState(null);
  const [usage, setUsage] = useState({});
  const [target, setTarget] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.listUsers()
      .then(result => setUsers(result.users))
      .catch(err => setError(err.message));

    api.allUsage()
      .then(result => setUsage(result.usage))
      .catch(() => {});
  }, []);

  async function submit(event) {
    event.preventDefault();
    setError('');
    setBusy(true);

    try {
      await api.resetPassword(target, password);
      notify(`Password reset for ${target}`, 'success');
      setTarget('');
      setPassword('');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Admin" onClose={onClose}>
      <h3 className="modal-section">Users</h3>

      {users === null ? (
        <p className="idle">Loading…</p>
      ) : (
        <ul className="user-list">
          {users.map(user => (
            <li key={user.username}>
              <div>
                <strong>{user.username}</strong>
                <span className="user-meta">
                  joined {relativeTime(user.createdAt)}
                  {usage[user.username] && ` · ${formatBytes(usage[user.username].bytes)} used`}
                </span>
              </div>
              <div className="user-side">
                {user.role === 'admin' && <span className="badge badge-admin">admin</span>}
                <button className="linkish" onClick={() => setTarget(user.username)}>reset</button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <h3 className="modal-section">Reset a password</h3>

      <form onSubmit={submit}>
        <Field label="Username" value={target} onChange={e => setTarget(e.target.value)} required />
        <Field label="New password" type="password" value={password}
          onChange={e => setPassword(e.target.value)} autoComplete="new-password" required />

        <Alert>{error}</Alert>

        <Button type="submit" variant="primary" busy={busy}>Reset password</Button>
      </form>
    </Modal>
  );
}


// The workstation is started by Task Scheduler, where its output goes nowhere
// anyone can read. This is the only way to see it without standing at it.
export function LogsModal({ onClose }) {
  const [files, setFiles] = useState(null);
  const [selected, setSelected] = useState('');
  const [tail, setTail] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    api.logs()
      .then(result => {
        setFiles(result.files);
        setSelected(result.files[0]?.name ?? '');
      })
      .catch(err => setError(err.message));
  }, []);

  useEffect(() => {
    if (!selected) return;

    let current = true;
    setBusy(true);

    api.logTail(selected)
      .then(text => current && setTail(text))
      .catch(err => current && setError(err.message))
      .finally(() => current && setBusy(false));

    return () => { current = false; };
  }, [selected, reloads]);

  return (
    <Modal title="Logs" onClose={onClose}>
      <Alert>{error}</Alert>

      {files === null ? (
        <p className="idle">Loading…</p>
      ) : files.length === 0 ? (
        <p className="idle">Nothing logged yet.</p>
      ) : (
        <>
          <label className="field">
            <span className="field-label">File</span>
            <select value={selected} onChange={e => setSelected(e.target.value)}>
              {files.map(file => (
                <option key={file.name} value={file.name}>
                  {file.name} — {formatBytes(file.bytes)}
                </option>
              ))}
            </select>
          </label>

          <pre className="log-tail">{busy ? 'Loading…' : tail}</pre>

          <Button busy={busy} onClick={() => setReloads(n => n + 1)}>
            Reload
          </Button>
        </>
      )}
    </Modal>
  );
}
