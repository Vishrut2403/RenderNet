import { useState } from 'react';
import { api, setSession } from '../api/client';
import { Alert, Button, Field } from '../components/ui';

export function Login({ onAuthenticated }) {
  const [mode, setMode] = useState('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setError('');
    setNotice('');
    setBusy(true);

    try {
      if (mode === 'signup') {
        await api.signup(username, password);
        setNotice('Account created — you can sign in now.');
        setMode('login');
        setPassword('');
      } else {
        const session = await api.login(username, password);
        setSession(session);
        onAuthenticated({ username: session.username, role: session.role });
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="brand">RenderNet</div>
        <p className="brand-sub">Distributed Blender rendering</p>

        <div className="tabs tabs-auth">
          <button className={mode === 'login' ? 'active' : ''} onClick={() => setMode('login')}>
            Sign in
          </button>
          <button className={mode === 'signup' ? 'active' : ''} onClick={() => setMode('signup')}>
            Create account
          </button>
        </div>

        <form onSubmit={submit}>
          <Field
            label="Username"
            value={username}
            onChange={e => setUsername(e.target.value)}
            autoComplete="username"
            required
          />
          <Field
            label="Password"
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
            hint={mode === 'signup' ? 'At least 6 characters' : undefined}
            required
          />

          <Alert>{error}</Alert>
          <Alert kind="success">{notice}</Alert>

          <Button type="submit" variant="primary" busy={busy}>
            {mode === 'signup' ? 'Create account' : 'Sign in'}
          </Button>
        </form>
      </div>
    </div>
  );
}
