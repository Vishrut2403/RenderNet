const BASE = import.meta.env.VITE_API_URL || '/api';

// Above this a file is sent in pieces and can be resumed.
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

// Strings whichever way the file goes up: the server reads a multipart form and
// a JSON body the same way.
function uploadSettings({
  frameStart, frameEnd, frameStep, renderEngine, priority, resolutionPercent, samples, formats,
  exrCodec, exrDepth, jpegQuality, skipAssetCheck, testFrame, tiles
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
  if (testFrame) settings.testFrame = String(testFrame);
  if (tiles) settings.tiles = String(tiles);

  return settings;
}

function send(xhr, payload, onLoaded) {
  // XHR rather than fetch: upload progress events have no fetch equivalent.
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
    // Resuming after a reload is a convenience; private windows do without it.
  }
}

function forget() {
  try {
    localStorage.removeItem(RESUME_KEY);
  } catch {
    // As above.
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

// The same file picked again after a reload or a dropped connection carries on
// from the byte the server last acknowledged. A session the server no longer
// has - it was swept, or the server restarted - simply starts again.
async function openUpload(file) {
  const previous = remembered(file);

  if (previous) {
    try {
      return await request(`/upload/session/${previous}`);
    } catch {
      forget();
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
      // Not a failure to retry: the server is saying where this should start.
      if (error.status === 409 && Number.isInteger(error.received)) {
        offset = error.received;
        continue;
      }

      if (error.status >= 400 || ++attempt >= CHUNK_ATTEMPTS) throw error;

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

// Sends the file the moment it is chosen, whatever its size, leaving it on the
// workstation to be read and then queued.
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

  forget();

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

  upload,
  prepareUpload,
  queuePrepared,

  inspectUpload: uploadId =>
    request(`/upload/session/${uploadId}/inspect`, { method: 'POST' }),

  // Nobody is waiting on the answer: a session left behind is swept anyway.
  // Forgotten as well as dropped, or the next pick would try to carry on from
  // bytes that are no longer there.
  abortUpload: uploadId => {
    forget();

    return request(`/upload/session/${uploadId}`, { method: 'DELETE' }).catch(() => {});
  }
};
