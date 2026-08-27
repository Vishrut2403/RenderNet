const BASE = import.meta.env.VITE_API_URL || '/api';

let onUnauthorized = () => {};
let onPasswordChangeRequired = () => {};

export function setUnauthorizedHandler(handler) {
  onUnauthorized = handler;
}

export function setPasswordChangeRequiredHandler(handler) {
  onPasswordChangeRequired = handler;
}

export function getToken() {
  return localStorage.getItem('rendernet.token');
}

export function setSession({ token, username, role, mustChangePassword }) {
  localStorage.setItem('rendernet.token', token);
  localStorage.setItem('rendernet.user', JSON.stringify({ username, role, mustChangePassword }));
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

function parseOrEmpty(text) {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function downloadUrl(path, token) {
  return `${BASE}${path}?token=${encodeURIComponent(token)}`;
}

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function request(path, { method = 'GET', body, headers = {}, auth = true, expect = 'json' } = {}) {
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

  // Drops the user back to the login screen rather than leaving stale errors.
  if (response.status === 401 && auth) {
    clearSession();
    onUnauthorized();
    throw new ApiError('Session expired', 401);
  }

  // Log tails come back as plain text; everything else is JSON.
  const payload = expect === 'text'
    ? { text: await response.text().catch(() => '') }
    : await response.json().catch(() => ({}));

  // Reachable from any call, so the app switches to that screen wherever it came
  // from.
  if (response.status === 403 && payload.mustChangePassword) {
    onPasswordChangeRequired();
  }

  if (!response.ok) {
    // A failed text request still answers with the usual JSON error body.
    const detail = expect === 'text' ? parseOrEmpty(payload.text) : payload;
    throw new ApiError(detail.error || `Request failed (${response.status})`, response.status);
  }

  return expect === 'text' ? payload.text : payload;
}

export const api = {
  login: (username, password) =>
    request('/auth/login', { method: 'POST', body: { username, password }, auth: false }),

  signup: (username, password, code) =>
    request('/auth/signup', { method: 'POST', body: { username, password, code }, auth: false }),

  logout: () => request('/auth/logout', { method: 'POST' }),

  verify: () => request('/auth/verify'),

  changePassword: (oldPassword, newPassword) =>
    request('/auth/change-password', { method: 'POST', body: { oldPassword, newPassword } }),

  listUsers: () => request('/auth/users'),

  health: () => request('/health'),

  logs: () => request('/logs'),

  logTail: (name, lines = 300) =>
    request(`/logs/${encodeURIComponent(name)}?lines=${lines}`, { expect: 'text' }),

  resetPassword: (targetUsername, newPassword) =>
    request('/auth/admin/reset-password', { method: 'POST', body: { targetUsername, newPassword } }),

  jobs: () => request('/jobs'),

  job: id => request(`/jobs/${id}`),

  queueStatus: () => request('/jobs/queue/status'),

  cancelJob: id => request(`/jobs/${id}/cancel`, { method: 'POST' }),

  deleteJob: id => request(`/jobs/${id}`, { method: 'DELETE' }),

  setPriority: (id, priority) =>
    request(`/jobs/${id}/priority`, { method: 'POST', body: { priority } }),

  rerunJob: id => request(`/jobs/${id}/rerun`, { method: 'POST' }),

  makeVideo: id => request(`/jobs/${id}/video`, { method: 'POST' }),

  videoUrl: (id, token) =>
    downloadUrl(`/download/files/render_${id}/render_${id}.mp4`, token),

  allUsage: () => request('/jobs/usage/all'),

  engines: () => request('/engines'),

  // Read-only, one job, minutes long: what a link or an <img> can carry when it
  // cannot carry the session.
  downloadToken: id => request(`/download/${id}/token`, { method: 'POST' }),

  // Built here because only the browser knows which API origin it is talking to.
  async jobFiles(id, token) {
    const result = await request(`/download/${id}/files`);

    return {
      ...result,
      files: result.files.map(file => ({ ...file, url: downloadUrl(file.path, token) }))
    };
  },

  zipUrl: (id, token) => downloadUrl(`/download/${id}/zip`, token),

  // Versioned by frame count so a new frame is not served from cache.
  previewUrl: (id, delivered, token) =>
    `${downloadUrl(`/download/${id}/preview`, token)}&v=${delivered}`,

  upload(file, {
    frameStart, frameEnd, renderEngine, priority, resolutionPercent, samples, formats,
    exrCodec, exrDepth, jpegQuality, skipAssetCheck
  }, onProgress) {
    // XHR rather than fetch: upload progress events have no fetch equivalent.
    return new Promise((resolve, reject) => {
      const form = new FormData();
      form.append('blend', file);
      form.append('frameStart', frameStart);
      form.append('frameEnd', frameEnd);
      form.append('renderEngine', renderEngine);
      form.append('resolutionPercent', resolutionPercent);
      if (samples) form.append('samples', samples);
      form.append('formats', (formats ?? ['PNG']).join(','));
      if (formats?.includes('OPEN_EXR')) {
        form.append('exrCodec', exrCodec);
        form.append('exrDepth', exrDepth);
      }
      if (formats?.includes('JPEG')) form.append('jpegQuality', jpegQuality);
      form.append('priority', priority ? 1 : 0);
      if (skipAssetCheck) form.append('skipAssetCheck', '1');

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
