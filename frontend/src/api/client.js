const BASE = import.meta.env.VITE_API_URL || '/api';

let onUnauthorized = () => {};

export function setUnauthorizedHandler(handler) {
  onUnauthorized = handler;
}

export function getToken() {
  return localStorage.getItem('rendernet.token');
}

export function setSession({ token, username, role }) {
  localStorage.setItem('rendernet.token', token);
  localStorage.setItem('rendernet.user', JSON.stringify({ username, role }));
}

export function getStoredUser() {
  const raw = localStorage.getItem('rendernet.user');
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function clearSession() {
  localStorage.removeItem('rendernet.token');
  localStorage.removeItem('rendernet.user');
}

// For URLs the browser fetches on its own - <img> sources and download links -
// which cannot carry an Authorization header.
function authorizedUrl(path) {
  return `${BASE}${path}?token=${encodeURIComponent(getToken())}`;
}

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function request(path, { method = 'GET', body, headers = {}, auth = true } = {}) {
  const token = getToken();
  const config = { method, headers: { ...headers } };

  if (auth && token) config.headers.Authorization = `Bearer ${token}`;

  if (body instanceof FormData) {
    config.body = body;
  } else if (body !== undefined) {
    config.headers['Content-Type'] = 'application/json';
    config.body = JSON.stringify(body);
  }

  const response = await fetch(`${BASE}${path}`, config);

  // An expired session should drop the user back to the login screen rather
  // than leaving every panel showing a stale error.
  if (response.status === 401 && auth) {
    clearSession();
    onUnauthorized();
    throw new ApiError('Session expired', 401);
  }

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new ApiError(payload.error || `Request failed (${response.status})`, response.status);
  }

  return payload;
}

export const api = {
  login: (username, password) =>
    request('/auth/login', { method: 'POST', body: { username, password }, auth: false }),

  signup: (username, password) =>
    request('/auth/signup', { method: 'POST', body: { username, password }, auth: false }),

  logout: () => request('/auth/logout', { method: 'POST' }),

  verify: () => request('/auth/verify'),

  changePassword: (oldPassword, newPassword) =>
    request('/auth/change-password', { method: 'POST', body: { oldPassword, newPassword } }),

  listUsers: () => request('/auth/users'),

  resetPassword: (targetUsername, newPassword) =>
    request('/auth/admin/reset-password', { method: 'POST', body: { targetUsername, newPassword } }),

  jobs: () => request('/jobs'),

  job: id => request(`/jobs/${id}`),

  queueStatus: () => request('/jobs/queue/status'),

  cancelJob: id => request(`/jobs/${id}/cancel`, { method: 'POST' }),

  // The frame URLs are built here rather than server-side: only the browser
  // knows which API origin it is talking to, and a token belongs in the URL
  // solely because <img> cannot carry an Authorization header.
  async jobFiles(id) {
    const result = await request(`/download/${id}/files`);

    return {
      ...result,
      files: result.files.map(file => ({ ...file, url: authorizedUrl(file.path) }))
    };
  },

  zipUrl: id => authorizedUrl(`/download/${id}/zip`),

  upload(file, { frameStart, frameEnd, renderEngine }, onProgress) {
    // XHR rather than fetch: upload progress events have no fetch equivalent.
    return new Promise((resolve, reject) => {
      const form = new FormData();
      form.append('blend', file);
      form.append('frameStart', frameStart);
      form.append('frameEnd', frameEnd);
      form.append('renderEngine', renderEngine);

      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${BASE}/upload`);
      xhr.setRequestHeader('Authorization', `Bearer ${getToken()}`);

      xhr.upload.addEventListener('progress', event => {
        if (event.lengthComputable) onProgress?.((event.loaded / event.total) * 100);
      });

      xhr.addEventListener('load', () => {
        let payload = {};
        try {
          payload = JSON.parse(xhr.responseText);
        } catch {
          // fall through to the status check below
        }

        if (xhr.status === 401) {
          clearSession();
          onUnauthorized();
          reject(new ApiError('Session expired', 401));
          return;
        }

        if (xhr.status >= 200 && xhr.status < 300) resolve(payload);
        else reject(new ApiError(payload.error || `Upload failed (${xhr.status})`, xhr.status));
      });

      xhr.addEventListener('error', () => reject(new ApiError('Network error during upload', 0)));

      xhr.send(form);
    });
  }
};
