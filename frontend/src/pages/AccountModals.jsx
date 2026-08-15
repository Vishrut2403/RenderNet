import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { Alert, Button, Field, Modal, relativeTime } from '../components/ui';

export function ChangePasswordModal({ onClose, notify }) {
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
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Change password" onClose={onClose}>
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
  const [target, setTarget] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.listUsers()
      .then(result => setUsers(result.users))
      .catch(err => setError(err.message));
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
                <span className="user-meta">joined {relativeTime(user.createdAt)}</span>
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
