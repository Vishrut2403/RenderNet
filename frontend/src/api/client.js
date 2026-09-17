const BASE = import.meta.env.VITE_API_URL || '/api';

const CHUNKED_ABOVE = 32 * 1024 * 1024;
const CHUNK_ATTEMPTS = 3;
const RESUME_KEY = 'rendernet.upload';

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

// fetch, not EventSource: the session token belongs in a header, never a URL.
export async function streamEvents(signal, onMessage) {
  const token = getToken();

  if (!token) throw new Error('No session');

  const response = await fetch(`${BASE}/events`, {
    signal,
    headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' }
  });

  if (!response.ok || !response.body) {
    throw new Error(`Events unavailable (${response.status})`);
  }

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffered = '';

  for (;;) {
    const { value, done } = await reader.read();

    if (done) return;

    buffered += value;

    const parts = buffered.split('\n\n');

    buffered = parts.pop();

    for (const part of parts) {
      if (part.split('\n').some(line => line.startsWith('data:'))) onMessage();
    }
  }
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
  constructor(message, status, received) {
    super(message);
    this.status = status;
    this.received = received;
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

  if (response.status === 401 && auth) {
    clearSession();
    onUnauthorized();
    throw new ApiError('Session expired', 401);
  }

  const payload = expect === 'text'
    ? { text: await response.text().catch(() => '') }
    : await response.json().catch(() => ({}));

  if (response.status === 403 && payload.mustChangePassword) {
    onPasswordChangeRequired();
  }

  if (!response.ok) {
    const detail = expect === 'text' ? parseOrEmpty(payload.text) : payload;
    throw new ApiError(detail.error || `Request failed (${response.status})`, response.status);
  }

  return expect === 'text' ? payload.text : payload;
}

function uploadSettings({
  frameStart, frameEnd, frameStep, renderEngine, priority, resolutionPercent, samples, formats,
  exrCodec, exrDepth, jpegQuality, skipAssetCheck, allowScripts, testFrame, tiles
}) {
  const settings = {
    frameStart: String(frameStart),
    frameEnd: String(frameEnd),
    frameStep: String(frameStep ?? 1),
    renderEngine,
    resolutionPercent: String(resolutionPercent),
    formats: (formats ?? ['PNG']).join(','),
    priority: priority ? '1' : '0'
  };

  if (samples) settings.samples = String(samples);

  if (formats?.includes('OPEN_EXR')) {
    settings.exrCodec = exrCodec;
    settings.exrDepth = String(exrDepth);
  }

  if (formats?.includes('JPEG')) settings.jpegQuality = String(jpegQuality);
  if (skipAssetCheck) settings.skipAssetCheck = '1';
  if (allowScripts) settings.allowScripts = '1';
  if (testFrame != null) settings.testFrame = String(testFrame);
  if (tiles) settings.tiles = String(tiles);

  return settings;
}

function send(xhr, payload, onLoaded) {
  return new Promise((resolve, reject) => {
    xhr.setRequestHeader('Authorization', `Bearer ${getToken()}`);

    xhr.upload.addEventListener('progress', event => {
      if (event.lengthComputable) onLoaded?.(event.loaded);
    });

    xhr.addEventListener('load', () => {
      const body = parseOrEmpty(xhr.responseText);

      if (xhr.status === 401) {
        clearSession();
        onUnauthorized();
        return reject(new ApiError('Session expired', 401));
      }

      if (xhr.status >= 200 && xhr.status < 300) return resolve(body);

      reject(new ApiError(body.error || `Upload failed (${xhr.status})`, xhr.status, body.received));
    });

    xhr.addEventListener('error', () => reject(new ApiError('Network error during upload', 0)));

    xhr.send(payload);
  });
}

function singleRequest(file, options, onProgress) {
  const form = new FormData();
  form.append('blend', file);

  for (const [name, value] of Object.entries(uploadSettings(options))) {
    form.append(name, value);
  }

  const xhr = new XMLHttpRequest();
  xhr.open('POST', `${BASE}/upload`);

  return send(xhr, form, loaded => onProgress?.((loaded / file.size) * 100));
}

function putChunk(uploadId, offset, piece, onLoaded) {
  const xhr = new XMLHttpRequest();
  xhr.open('PUT', `${BASE}/upload/session/${uploadId}?offset=${offset}`);
  xhr.setRequestHeader('Content-Type', 'application/octet-stream');

  return send(xhr, piece, onLoaded);
}

function remember(file, uploadId) {
  try {
    localStorage.setItem(RESUME_KEY, JSON.stringify({
      uploadId, name: file.name, size: file.size, lastModified: file.lastModified
    }));
  } catch {
  }
}

// Only this upload's entry: another file picked since may have saved its own.
function forget(uploadId) {
  try {
    const stored = JSON.parse(localStorage.getItem(RESUME_KEY) || 'null');
    if (stored?.uploadId === uploadId) localStorage.removeItem(RESUME_KEY);
  } catch {
  }
}

function remembered(file) {
  try {
    const stored = JSON.parse(localStorage.getItem(RESUME_KEY) || 'null');

    if (stored?.name !== file.name) return null;
    if (stored.size !== file.size || stored.lastModified !== file.lastModified) return null;

    return stored.uploadId;
  } catch {
    return null;
  }
}

async function openUpload(file) {
  const previous = remembered(file);

  if (previous) {
    try {
      return await request(`/upload/session/${previous}`);
    } catch {
      forget(previous);
    }
  }

  const started = await request('/upload/session', {
    method: 'POST',
    body: { filename: file.name, size: file.size }
  });

  remember(file, started.uploadId);

  return started;
}

function pause(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function sendChunks(file, session, onProgress) {
  let offset = session.received;
  let attempt = 0;

  while (offset < file.size) {
    const end = Math.min(offset + session.chunkSize, file.size);

    try {
      const written = await putChunk(session.uploadId, offset, file.slice(offset, end),
        loaded => onProgress?.(((offset + loaded) / file.size) * 100));

      offset = written.received;
      attempt = 0;
    } catch (error) {
      if (error.status === 409 && Number.isInteger(error.received)) {
        offset = error.received;
        continue;
      }

      // A 409 with no offset is the server still holding a chunk whose
      // connection just dropped: worth waiting out, like a network error.
      const transient = error.status === 409 || !(error.status >= 400);

      if (!transient || ++attempt >= CHUNK_ATTEMPTS) throw error;

      await pause(attempt * 1000);
    }
  }
}

async function upload(file, options, onProgress) {
  if (file.size <= CHUNKED_ABOVE) return singleRequest(file, options, onProgress);

  const session = await openUpload(file);

  await sendChunks(file, session, onProgress);

  return queuePrepared(session.uploadId, options);
}

async function prepareUpload(file, onProgress) {
  const session = await openUpload(file);

  await sendChunks(file, session, onProgress);

  return session.uploadId;
}

async function queuePrepared(uploadId, options) {
  const queued = await request(`/upload/session/${uploadId}/finish`, {
    method: 'POST',
    body: uploadSettings(options)
  });

  forget(uploadId);

  return queued;
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

  approveJob: id => request(`/jobs/${id}/approve`, { method: 'POST' }),

  supplyAsset: (id, stored, file) => {
    const form = new FormData();
    form.append('for', stored);
    form.append('asset', file);

    return request(`/jobs/${id}/assets`, { method: 'POST', body: form });
  },

  signupCode: () => request('/auth/signup-code'),

  newSignupCode: () => request('/auth/signup-code', { method: 'POST' }),

  machines: () => request('/machines'),

  addMachine: name => request('/machines', { method: 'POST', body: { name } }),

  revokeMachine: id => request(`/machines/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  health: () => request('/health'),

  logs: () => request('/logs'),

  logTail: (name, lines = 300) =>
    request(`/logs/${encodeURIComponent(name)}?lines=${lines}`, { expect: 'text' }),

  resetPassword: (targetUsername, newPassword) =>
    request('/auth/admin/reset-password', { method: 'POST', body: { targetUsername, newPassword } }),

  jobs: ({ status, before, limit } = {}) => {
    const query = new URLSearchParams();

    if (status && status !== 'all') query.set('status', status);
    if (before) query.set('before', before);
    if (limit) query.set('limit', limit);

    return request(`/jobs${query.size ? `?${query}` : ''}`);
  },

  jobsSummary: () => request('/jobs/summary'),

  job: id => request(`/jobs/${id}`),

  queueStatus: () => request('/jobs/queue/status'),

  cancelJob: id => request(`/jobs/${id}/cancel`, { method: 'POST' }),

  deleteJob: id => request(`/jobs/${id}`, { method: 'DELETE' }),

  setPriority: (id, priority) =>
    request(`/jobs/${id}/priority`, { method: 'POST', body: { priority } }),

  rerunJob: id => request(`/jobs/${id}/rerun`, { method: 'POST' }),

  holdJob: id => request(`/jobs/${id}/hold`, { method: 'POST' }),

  releaseJob: id => request(`/jobs/${id}/release`, { method: 'POST' }),

  pinJob: (id, pinned) => request(`/jobs/${id}/pin`, { method: 'POST', body: { pinned } }),

  makeVideo: id => request(`/jobs/${id}/video`, { method: 'POST' }),

  videoUrl: (id, token) => downloadUrl(`/download/${id}/video`, token),

  allUsage: () => request('/jobs/usage/all'),

  engines: () => request('/engines'),

  downloadToken: id => request(`/download/${id}/token`, { method: 'POST' }),

  jobFiles: id => request(`/download/${id}/files`),

  fileUrl: (path, token) => downloadUrl(path, token),

  zipUrl: (id, token) => downloadUrl(`/download/${id}/zip`, token),

  previewUrl: (id, delivered, token) =>
    `${downloadUrl(`/download/${id}/preview`, token)}&v=${delivered}`,

  upload,
  prepareUpload,
  queuePrepared,

  inspectUpload: uploadId =>
    request(`/upload/session/${uploadId}/inspect`, { method: 'POST' }),

  abortUpload: uploadId => {
    forget(uploadId);

    return request(`/upload/session/${uploadId}`, { method: 'DELETE' }).catch(() => {});
  }
};
