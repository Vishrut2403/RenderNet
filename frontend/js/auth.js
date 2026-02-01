const AUTH_TOKEN_KEY = 'renderfarm_token';
const AUTH_USER_KEY = 'renderfarm_user';

class Auth {
  constructor() {
    this.token = localStorage.getItem(AUTH_TOKEN_KEY);
    this.currentUser = localStorage.getItem(AUTH_USER_KEY);
  }

  getToken() {
    return this.token;
  }

  getCurrentUser() {
    return this.currentUser;
  }

  isLoggedIn() {
    return !!this.token && !!this.currentUser;
  }

  async login(username, password) {
    try {
      const response = await fetch(`${API_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });

      const data = await response.json();

      if (!response.ok) {
        return { success: false, error: data.error };
      }

      this.token = data.token;
      this.currentUser = data.username;
      localStorage.setItem(AUTH_TOKEN_KEY, data.token);
      localStorage.setItem(AUTH_USER_KEY, data.username);

      return { success: true, username: data.username, role: data.role };

    } catch (error) {
      return { success: false, error: 'Connection failed. Is the server running?' };
    }
  }

  async signup(username, password) {
    try {
      const response = await fetch(`${API_URL}/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });

      const data = await response.json();

      if (!response.ok) {
        return { success: false, error: data.error };
      }

      return { success: true, message: data.message };

    } catch (error) {
      return { success: false, error: 'Connection failed. Is the server running?' };
    }
  }

  async changePassword(oldPassword, newPassword) {
    try {
      const response = await fetch(`${API_URL}/auth/change-password`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`
        },
        body: JSON.stringify({ oldPassword, newPassword })
      });

      const data = await response.json();

      if (!response.ok) {
        return { success: false, error: data.error };
      }

      return { success: true, message: data.message };

    } catch (error) {
      return { success: false, error: 'Connection failed' };
    }
  }

  logout() {
    localStorage.removeItem(AUTH_TOKEN_KEY);
    localStorage.removeItem(AUTH_USER_KEY);
    this.token = null;
    this.currentUser = null;
  }
}

const auth = new Auth();

document.getElementById('show-signup')?.addEventListener('click', (e) => {
  e.preventDefault();
  document.getElementById('login-form').style.display = 'none';
  document.getElementById('signup-form').style.display = 'block';
  document.getElementById('login-error').classList.remove('show');
});

document.getElementById('show-login')?.addEventListener('click', (e) => {
  e.preventDefault();
  document.getElementById('signup-form').style.display = 'none';
  document.getElementById('login-form').style.display = 'block';
  document.getElementById('signup-error').classList.remove('show');
  document.getElementById('signup-success').classList.remove('show');
});

document.getElementById('login-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();

  console.log('Login form submitted');
  
  const username = document.getElementById('username').value;
  const password = document.getElementById('password').value;
  const errorEl = document.getElementById('login-error');
  const submitBtn = e.target.querySelector('button[type="submit"]');

  console.log('Username:', username);

  submitBtn.disabled = true;
  submitBtn.textContent = 'Logging in...';
  
  console.log('Calling auth.login...');
  const result = await auth.login(username, password);
  console.log('Login result:', result);

  submitBtn.disabled = false;
  submitBtn.textContent = 'Login';
  
  if (result.success) {
    console.log('Login successful, switching screens...');
    
    window.tokenValidated = true;
    
    const loginScreen = document.getElementById('login-screen');
    const appScreen = document.getElementById('app-screen');
    
    console.log('Login screen element:', loginScreen);
    console.log('App screen element:', appScreen);
    
    if (loginScreen && appScreen) {
      loginScreen.classList.remove('active');
      appScreen.classList.add('active');
      console.log('Screen switched');
    } else {
      console.error('Screen elements not found!');
    }
    
    const currentUserEl = document.getElementById('current-user');
    if (currentUserEl) {
      currentUserEl.textContent = username;
    }
    
    const settingsUsernameEl = document.getElementById('settings-username');
    if (settingsUsernameEl) {
      settingsUsernameEl.textContent = username;
    }
    
    const settingsRoleEl = document.getElementById('settings-role');
    if (settingsRoleEl) {
      settingsRoleEl.textContent = result.role || 'user';
    }

    setTimeout(() => {
      checkAndShowAdminSection();
    }, 500);
    
    setTimeout(() => {
      console.log('Loading initial data...');
      if (window.loadJobs) window.loadJobs();
      if (window.loadQueueStatus) window.loadQueueStatus();
      if (window.loadDashboard) window.loadDashboard();

      if (window.startJobsRefresh) window.startJobsRefresh();
      if (window.startQueueRefresh) window.startQueueRefresh();
    }, 100);
    
  } else {
    console.error('Login failed:', result.error);
    errorEl.textContent = result.error;
    errorEl.classList.add('show');
  }
});

document.getElementById('signup-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const username = document.getElementById('signup-username').value;
  const password = document.getElementById('signup-password').value;
  const passwordConfirm = document.getElementById('signup-password-confirm').value;
  const errorEl = document.getElementById('signup-error');
  const successEl = document.getElementById('signup-success');
  const submitBtn = e.target.querySelector('button[type="submit"]');
  
  errorEl.classList.remove('show');
  successEl.classList.remove('show');
  
  if (password !== passwordConfirm) {
    errorEl.textContent = 'Passwords do not match';
    errorEl.classList.add('show');
    return;
  }
  
  submitBtn.disabled = true;
  submitBtn.textContent = 'Creating account...';
  
  const result = await auth.signup(username, password);
  
  submitBtn.disabled = false;
  submitBtn.textContent = 'Create Account';
  
  if (result.success) {
    successEl.textContent = 'Account created! You can now log in.';
    successEl.classList.add('show');
    
    e.target.reset();
    
    setTimeout(() => {
      document.getElementById('show-login').click();
    }, 2000);
    
  } else {
    errorEl.textContent = result.error;
    errorEl.classList.add('show');
  }
});

document.getElementById('change-password-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const currentPassword = document.getElementById('current-password').value;
  const newPassword = document.getElementById('new-password').value;
  const newPasswordConfirm = document.getElementById('new-password-confirm').value;
  const errorEl = document.getElementById('password-error');
  const successEl = document.getElementById('password-success');
  const submitBtn = e.target.querySelector('button[type="submit"]');
  
  errorEl.classList.remove('show');
  successEl.classList.remove('show');
  
  if (newPassword !== newPasswordConfirm) {
    errorEl.textContent = 'New passwords do not match';
    errorEl.classList.add('show');
    return;
  }
  
  submitBtn.disabled = true;
  submitBtn.textContent = 'Changing password...';
  
  const result = await auth.changePassword(currentPassword, newPassword);
  
  submitBtn.disabled = false;
  submitBtn.textContent = 'Change Password';
  
  if (result.success) {
    successEl.textContent = 'Password changed successfully!';
    successEl.classList.add('show');
    e.target.reset();
  } else {
    errorEl.textContent = result.error;
    errorEl.classList.add('show');
  }
});

function logout() {
  console.log('Logging out...');
  auth.logout();
  
  window.tokenValidated = false;
  
  if (window.stopJobsRefresh) window.stopJobsRefresh();
  if (window.stopQueueRefresh) window.stopQueueRefresh();
  
  document.getElementById('app-screen').classList.remove('active');
  document.getElementById('login-screen').classList.add('active');
  
  const usernameEl = document.getElementById('username');
  const passwordEl = document.getElementById('password');
  const loginErrorEl = document.getElementById('login-error');
  
  if (usernameEl) usernameEl.value = '';
  if (passwordEl) passwordEl.value = '';
  if (loginErrorEl) loginErrorEl.classList.remove('show');
  
  const signupForm = document.getElementById('signup-form');
  const loginForm = document.getElementById('login-form');
  
  if (signupForm) signupForm.style.display = 'none';
  if (loginForm) loginForm.style.display = 'block';
  
  console.log('Logged out successfully');
}

document.getElementById('logout-btn')?.addEventListener('click', logout);

let isCheckingAdmin = false; 

function checkAndShowAdminSection() {
  if (!auth || !auth.getToken || !auth.getToken()) {
    console.log('Not logged in, skipping admin check');
    return;
  }
  
  if (isCheckingAdmin) {
    console.log('Admin check already in progress, skipping');
    return;
  }
  
  isCheckingAdmin = true;
  console.log('Checking if user is admin...');
  
  fetch(`${API_URL}/auth/verify`, {
    headers: { 'Authorization': `Bearer ${auth.getToken()}` }
  })
  .then(res => {
    if (!res.ok) {
      console.log('Auth verify failed, status:', res.status);
      isCheckingAdmin = false;
      return null;
    }
    return res.json();
  })
  .then(data => {
    isCheckingAdmin = false;
    if (!data) return;
    
    console.log('Auth verified, role:', data.role);
    
    if (data.role === 'admin') {
      console.log('👑 User is admin, showing admin sections');
      showAdminMenuItem();
      
      const adminResetSection = document.getElementById('admin-reset-section');
      if (adminResetSection) {
        adminResetSection.style.display = 'block';
        console.log('Admin reset section shown');
      }
      
      const adminCreateSection = document.getElementById('admin-create-user');
      if (adminCreateSection) {
        adminCreateSection.style.display = 'block';
        console.log('Admin create user section shown');
      }
      
      const settingsRoleEl = document.getElementById('settings-role');
      if (settingsRoleEl) {
        settingsRoleEl.textContent = 'Admin';
      }
    } else {
      console.log('User is regular user (not admin)');
    }
  })
  .catch(err => {
    isCheckingAdmin = false;
    console.error('Error checking admin status:', err);
  });
}

document.getElementById('admin-reset-password-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const targetUsername = document.getElementById('reset-target-username').value;
  const newPassword = document.getElementById('reset-new-password').value;
  const errorEl = document.getElementById('reset-password-error');
  const successEl = document.getElementById('reset-password-success');
  const submitBtn = e.target.querySelector('button[type="submit"]');
  
  errorEl.classList.remove('show');
  successEl.classList.remove('show');
  
  submitBtn.disabled = true;
  submitBtn.textContent = 'Resetting...';
  
  try {
    const response = await fetch(`${API_URL}/auth/admin/reset-password`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${auth.getToken()}`
      },
      body: JSON.stringify({ targetUsername, newPassword })
    });
    
    const data = await response.json();
    
    submitBtn.disabled = false;
    submitBtn.textContent = 'Reset Password';
    
    if (response.ok) {
      successEl.innerHTML = `Password reset!<br>New password for <strong>${targetUsername}</strong>: <code style="background: var(--background); padding: 0.25rem 0.5rem; border-radius: 4px;">${newPassword}</code><br><small>Give this to the user</small>`;
      successEl.classList.add('show');
      setTimeout(() => e.target.reset(), 5000);
    } else {
      errorEl.textContent = data.error;
      errorEl.classList.add('show');
    }
  } catch (error) {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Reset Password';
    errorEl.textContent = 'Failed to reset password';
    errorEl.classList.add('show');
  }
});

window.tokenValidated = false;

if (auth.isLoggedIn() && !window.tokenValidated) {
  window.tokenValidated = true; 
  console.log('User already logged in:', auth.getCurrentUser());
  
  fetch(`${API_URL}/auth/verify`, {
    headers: { 'Authorization': `Bearer ${auth.getToken()}` }
  })
  .then(res => {
    if (!res.ok) {
      console.log('Stored token is invalid, clearing session');
      auth.logout();
      window.tokenValidated = false; 
      document.getElementById('app-screen').classList.remove('active');
      document.getElementById('login-screen').classList.add('active');
      return null;
    }
    return res.json();
  })
  .then(data => {
    if (!data) return;
    
    document.getElementById('login-screen').classList.remove('active');
    document.getElementById('app-screen').classList.add('active');
    
    const currentUserEl = document.getElementById('current-user');
    if (currentUserEl) currentUserEl.textContent = auth.currentUser;
    
    const settingsUsernameEl = document.getElementById('settings-username');
    if (settingsUsernameEl) settingsUsernameEl.textContent = auth.currentUser;
    
    setTimeout(() => {
      checkAndShowAdminSection();
    }, 100);
    
    setTimeout(() => {
      if (window.loadJobs) window.loadJobs();
      if (window.loadQueueStatus) window.loadQueueStatus();
      if (window.loadDashboard) window.loadDashboard();
      
      if (window.startJobsRefresh) window.startJobsRefresh();
      if (window.startQueueRefresh) window.startQueueRefresh();
    }, 200);
  })
  .catch(err => {
    console.error('Error verifying token:', err);
    auth.logout();
    window.tokenValidated = false;
    document.getElementById('app-screen').classList.remove('active');
    document.getElementById('login-screen').classList.add('active');
  });
}

document.getElementById('user-menu-btn')?.addEventListener('click', (e) => {
  e.stopPropagation();
  const dropdown = document.getElementById('user-dropdown');
  dropdown.style.display = dropdown.style.display === 'none' ? 'block' : 'none';
});

document.addEventListener('click', (e) => {
  const dropdown = document.getElementById('user-dropdown');
  const menuBtn = document.getElementById('user-menu-btn');
  
  if (dropdown && menuBtn && !menuBtn.contains(e.target) && !dropdown.contains(e.target)) {
    dropdown.style.display = 'none';
  }
});

function showAdminMenuItem() {
  const adminMenuItem = document.getElementById('admin-menu-item');
  if (adminMenuItem) {
    adminMenuItem.style.display = 'flex';
  }
}

function openChangePasswordModal() {
  document.getElementById('password-modal').style.display = 'flex';
  document.getElementById('user-dropdown').style.display = 'none';
}

function closeChangePasswordModal() {
  document.getElementById('password-modal').style.display = 'none';
  document.getElementById('modal-change-password-form').reset();
  document.getElementById('modal-password-error').classList.remove('show');
  document.getElementById('modal-password-success').classList.remove('show');
}

function openAdminPanel() {
  document.getElementById('admin-modal').style.display = 'flex';
  document.getElementById('user-dropdown').style.display = 'none';
}

function closeAdminPanel() {
  document.getElementById('admin-modal').style.display = 'none';
  document.getElementById('modal-admin-reset-form').reset();
  document.getElementById('modal-reset-error').classList.remove('show');
  document.getElementById('modal-reset-success').classList.remove('show');
}

document.getElementById('modal-change-password-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const currentPassword = document.getElementById('modal-current-password').value;
  const newPassword = document.getElementById('modal-new-password').value;
  const newPasswordConfirm = document.getElementById('modal-new-password-confirm').value;
  const errorEl = document.getElementById('modal-password-error');
  const successEl = document.getElementById('modal-password-success');
  const submitBtn = e.target.querySelector('button[type="submit"]');
  
  errorEl.classList.remove('show');
  successEl.classList.remove('show');
  
  if (newPassword !== newPasswordConfirm) {
    errorEl.textContent = 'New passwords do not match';
    errorEl.classList.add('show');
    return;
  }
  
  submitBtn.disabled = true;
  submitBtn.textContent = 'Changing...';
  
  const result = await auth.changePassword(currentPassword, newPassword);
  
  submitBtn.disabled = false;
  submitBtn.textContent = 'Change Password';
  
  if (result.success) {
    successEl.textContent = 'Password changed successfully!';
    successEl.classList.add('show');
    setTimeout(() => {
      closeChangePasswordModal();
    }, 2000);
  } else {
    errorEl.textContent = result.error;
    errorEl.classList.add('show');
  }
});

document.getElementById('modal-admin-reset-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const targetUsername = document.getElementById('modal-reset-username').value;
  const newPassword = document.getElementById('modal-reset-password').value;
  const errorEl = document.getElementById('modal-reset-error');
  const successEl = document.getElementById('modal-reset-success');
  const submitBtn = e.target.querySelector('button[type="submit"]');
  
  errorEl.classList.remove('show');
  successEl.classList.remove('show');
  
  submitBtn.disabled = true;
  submitBtn.textContent = 'Resetting...';
  
  try {
    const response = await fetch(`${API_URL}/auth/admin/reset-password`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${auth.getToken()}`
      },
      body: JSON.stringify({ targetUsername, newPassword })
    });
    
    const data = await response.json();
    
    submitBtn.disabled = false;
    submitBtn.textContent = 'Reset Password';
    
    if (response.ok) {
      successEl.innerHTML = `Password reset for <strong>${targetUsername}</strong><br>New password: <code style="background: var(--background); padding: 0.25rem 0.5rem; border-radius: 4px;">${newPassword}</code>`;
      successEl.classList.add('show');
      setTimeout(() => e.target.reset(), 5000);
    } else {
      errorEl.textContent = data.error;
      errorEl.classList.add('show');
    }
  } catch (error) {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Reset Password';
    errorEl.textContent = 'Failed to reset password';
    errorEl.classList.add('show');
  }
});

async function loadUsersInModal() {
  const usersList = document.getElementById('modal-users-list');
  usersList.innerHTML = '<p style="color: var(--text-muted);">Loading...</p>';
  
  try {
    const response = await fetch(`${API_URL}/auth/users`, {
      headers: { 'Authorization': `Bearer ${auth.getToken()}` }
    });
    
    if (!response.ok) {
      usersList.innerHTML = '<p style="color: var(--danger);">Failed to load users</p>';
      return;
    }
    
    const data = await response.json();
    
    if (data.users.length === 0) {
      usersList.innerHTML = '<p style="color: var(--text-muted);">No users found</p>';
      return;
    }
    
    usersList.innerHTML = data.users.map(user => `
      <div class="user-list-item">
        <div class="user-info">
          <span class="user-username">${user.username}</span>
          <span class="user-meta">Created: ${new Date(user.createdAt).toLocaleDateString()}</span>
        </div>
        <span class="user-role-badge role-${user.role}">${user.role.toUpperCase()}</span>
      </div>
    `).join('');
  } catch (error) {
    console.error('Error loading users:', error);
    usersList.innerHTML = '<p style="color: var(--danger);">Error loading users</p>';
  }
}

window.auth = auth;
window.logout = logout;
window.openChangePasswordModal = openChangePasswordModal;
window.closeChangePasswordModal = closeChangePasswordModal;
window.openAdminPanel = openAdminPanel;
window.closeAdminPanel = closeAdminPanel;
window.loadUsersInModal = loadUsersInModal;
window.showAdminMenuItem = showAdminMenuItem;
window.checkAndShowAdminSection = checkAndShowAdminSection;

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeChangePasswordModal();
    closeAdminPanel();
  }
});