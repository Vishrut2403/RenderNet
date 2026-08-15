import { useCallback, useEffect, useState } from 'react';
import { api, clearSession, getStoredUser, getToken, setUnauthorizedHandler } from './api/client';
import { Login } from './pages/Login';
import { Upload } from './pages/Upload';
import { Jobs } from './pages/Jobs';
import { Dashboard } from './pages/Dashboard';
import { ChangePasswordModal, AdminModal } from './pages/AccountModals';
import { Toast } from './components/ui';

const TABS = [
  ['dashboard', 'Dashboard'],
  ['upload', 'Upload'],
  ['jobs', 'Jobs']
];

export default function App() {
  const [user, setUser] = useState(getStoredUser);
  const [checking, setChecking] = useState(Boolean(getToken()));
  const [tab, setTab] = useState('dashboard');
  const [modal, setModal] = useState(null);
  const [toast, setToast] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const notify = useCallback((message, kind = 'info') => setToast({ message, kind }), []);

  const signOut = useCallback(() => {
    clearSession();
    setUser(null);
    setMenuOpen(false);
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setUser(null);
      notify('Session expired — please sign in again', 'error');
    });
  }, [notify]);

  // A stored token may have expired while the tab was closed.
  useEffect(() => {
    if (!getToken()) return;

    api.verify()
      .then(result => setUser({ username: result.username, role: result.role }))
      .catch(() => clearSession())
      .finally(() => setChecking(false));
  }, []);

  if (checking) {
    return <div className="boot">Checking session…</div>;
  }

  if (!user) {
    return <Login onAuthenticated={setUser} />;
  }

  async function handleSignOut() {
    try {
      await api.logout();
    } catch {
      // The local session is cleared either way.
    }
    signOut();
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">RenderNet</div>

        <nav className="tabs tabs-main">
          {TABS.map(([key, label]) => (
            <button key={key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>
              {label}
            </button>
          ))}
        </nav>

        <div className="account">
          <button className="account-btn" onClick={() => setMenuOpen(open => !open)}>
            {user.username}
          </button>

          {menuOpen && (
            <>
              <div className="menu-scrim" onClick={() => setMenuOpen(false)} />
              <div className="menu">
                <button onClick={() => { setModal('password'); setMenuOpen(false); }}>
                  Change password
                </button>
                {user.role === 'admin' && (
                  <button onClick={() => { setModal('admin'); setMenuOpen(false); }}>
                    Admin
                  </button>
                )}
                <button className="danger" onClick={handleSignOut}>Sign out</button>
              </div>
            </>
          )}
        </div>
      </header>

      <main className="content">
        {tab === 'dashboard' && <Dashboard key={`d${reloadKey}`} notify={notify} />}
        {tab === 'upload' && (
          <Upload
            notify={notify}
            onSubmitted={() => { setReloadKey(k => k + 1); setTab('jobs'); }}
          />
        )}
        {tab === 'jobs' && <Jobs key={`j${reloadKey}`} notify={notify} />}
      </main>

      {modal === 'password' && (
        <ChangePasswordModal onClose={() => setModal(null)} notify={notify} />
      )}
      {modal === 'admin' && (
        <AdminModal onClose={() => setModal(null)} notify={notify} />
      )}

      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </div>
  );
}
