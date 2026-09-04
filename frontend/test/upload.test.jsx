// How a scene gets to the server. Everything below 32MB is one request; above
// it the file goes in pieces that can be resumed, which is the part with the
// most ways to go wrong and the least chance of being noticed by hand.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { api, setSession } from '../src/api/client';

const MB = 1024 * 1024;

// The uploader only ever asks a file for these four, so a test does not have to
// allocate forty megabytes to describe one.
function fakeFile({ name = 'scene.blend', size = 40 * MB, lastModified = 1000 } = {}) {
  return {
    name,
    size,
    lastModified,
    slice: (start, end) => ({ byteLength: end - start, start, end })
  };
}

let sent;
let respond;

// jsdom has no XMLHttpRequest that talks to anything, so this stands in for it
// and records what the uploader asked for.
class FakeXhr {
  constructor() {
    this.upload = { addEventListener: (name, fn) => { this.onProgress = fn; } };
    this.listeners = {};
  }

  open(method, url) {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name, value) {
    this.headers = { ...this.headers, [name]: value };
  }

  addEventListener(name, fn) {
    this.listeners[name] = fn;
  }

  send(payload) {
    const record = { method: this.method, url: this.url, payload, xhr: this };
    sent.push(record);

    // Answered on a later tick, the way a real request is.
    queueMicrotask(() => {
      const answer = respond(record, sent.length - 1);

      if (answer.networkError) return this.listeners.error?.();

      this.status = answer.status ?? 200;
      this.responseText = JSON.stringify(answer.body ?? {});
      this.listeners.load?.();
    });
  }
}

function offsetOf(record) {
  return Number(new URL(record.url, 'http://x').searchParams.get('offset'));
}

beforeEach(() => {
  sent = [];
  respond = () => ({ status: 200, body: {} });
  setSession({ token: 'test-token', username: 'painter', role: 'user' });
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function mockFetch(handler) {
  vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => handler(String(url), options),
    text: async () => ''
  })));
}

describe('a scene small enough to send in one go', () => {
  it('is posted as a form rather than opening a session', async () => {
    mockFetch(() => ({}));
    respond = () => ({ status: 200, body: { jobId: 7 } });

    const file = new File(['x'], 'small.blend', { lastModified: 1 });
    const queued = await api.upload(file, { frameStart: 1, frameEnd: 2, formats: ['PNG'] });

    expect(queued.jobId).toBe(7);
    expect(sent).toHaveLength(1);
    expect(sent[0].method).toBe('POST');
    expect(sent[0].url).toMatch(/\/upload$/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('and carries the settings the job was submitted with', async () => {
    mockFetch(() => ({}));
    respond = () => ({ status: 200, body: { jobId: 8 } });

    const file = new File(['x'], 'small.blend', { lastModified: 1 });
    await api.upload(file, {
      frameStart: 1, frameEnd: 4, formats: ['PNG'], tiles: 4, testFrame: 2, priority: 1
    });

    const form = sent[0].payload;

    expect(form.get('frameStart')).toBe('1');
    expect(form.get('tiles')).toBe('4');
    expect(form.get('testFrame')).toBe('2');
    expect(form.get('priority')).toBe('1');
  });
});

describe('a scene too big for one request', () => {
  it('opens a session and sends it in pieces', async () => {
    mockFetch((url, options) => {
      if (options.method === 'POST' && url.endsWith('/upload/session')) {
        return { uploadId: 'abc', received: 0, chunkSize: 16 * MB };
      }
      return { jobId: 11 };
    });

    respond = record => ({ status: 200, body: { received: offsetOf(record) + 16 * MB } });

    const queued = await api.upload(fakeFile({ size: 40 * MB }),
      { frameStart: 1, frameEnd: 1, formats: ['PNG'] });

    expect(queued.jobId).toBe(11);
    expect(sent.map(offsetOf)).toEqual([0, 16 * MB, 32 * MB]);
    expect(sent.every(record => record.method === 'PUT')).toBe(true);
  });

  it('sends the last piece short rather than past the end of the file', async () => {
    mockFetch((url, options) => options.method === 'POST' && url.endsWith('/upload/session')
      ? { uploadId: 'abc', received: 0, chunkSize: 16 * MB }
      : { jobId: 1 });

    respond = record => ({ status: 200, body: { received: offsetOf(record) + 16 * MB } });

    await api.upload(fakeFile({ size: 40 * MB }), { frameStart: 1, frameEnd: 1 });

    expect(sent.at(-1).payload.byteLength).toBe(8 * MB);
  });

  it('carries on from where the server says it got to', async () => {
    mockFetch((url, options) => options.method === 'POST' && url.endsWith('/upload/session')
      ? { uploadId: 'abc', received: 0, chunkSize: 16 * MB }
      : { jobId: 1 });

    // The server took less of the first piece than was offered.
    respond = (record, index) => index === 0
      ? { status: 200, body: { received: 10 * MB } }
      : { status: 200, body: { received: offsetOf(record) + 16 * MB } };

    await api.upload(fakeFile({ size: 40 * MB }), { frameStart: 1, frameEnd: 1 });

    expect(sent.map(offsetOf)).toEqual([0, 10 * MB, 26 * MB]);
  });

  it('reports progress against the whole file, not the piece', async () => {
    mockFetch((url, options) => options.method === 'POST' && url.endsWith('/upload/session')
      ? { uploadId: 'abc', received: 0, chunkSize: 16 * MB }
      : { jobId: 1 });

    respond = record => ({ status: 200, body: { received: offsetOf(record) + 16 * MB } });

    const seen = [];
    const file = fakeFile({ size: 40 * MB });

    vi.stubGlobal('XMLHttpRequest', class extends FakeXhr {
      send(payload) {
        this.onProgress?.({ lengthComputable: true, loaded: payload.byteLength });
        super.send(payload);
      }
    });

    await api.upload(file, { frameStart: 1, frameEnd: 1 }, percent => seen.push(percent));

    expect(seen).toEqual([40, 80, 100]);
  });
});

describe('when a piece does not land', () => {
  it('a wrong offset is not a retry: it resyncs to where the server is', async () => {
    mockFetch((url, options) => options.method === 'POST' && url.endsWith('/upload/session')
      ? { uploadId: 'abc', received: 0, chunkSize: 16 * MB }
      : { jobId: 1 });

    respond = (record, index) => index === 0
      ? { status: 409, body: { error: 'Expected the chunk starting at 4194304', received: 4 * MB } }
      : { status: 200, body: { received: offsetOf(record) + 20 * MB } };

    await api.upload(fakeFile({ size: 40 * MB }), { frameStart: 1, frameEnd: 1 });

    expect(sent.map(offsetOf)).toEqual([0, 4 * MB, 24 * MB]);
  });

  it('a dropped connection is tried again', async () => {
    vi.useFakeTimers();

    mockFetch((url, options) => options.method === 'POST' && url.endsWith('/upload/session')
      ? { uploadId: 'abc', received: 0, chunkSize: 40 * MB }
      : { jobId: 1 });

    respond = (record, index) => index === 0
      ? { networkError: true }
      : { status: 200, body: { received: 40 * MB } };

    const uploading = api.upload(fakeFile({ size: 40 * MB }), { frameStart: 1, frameEnd: 1 });

    await vi.advanceTimersByTimeAsync(2000);
    await uploading;

    expect(sent).toHaveLength(2);
    expect(sent.map(offsetOf)).toEqual([0, 0]);

    vi.useRealTimers();
  });

  it('but gives up rather than trying for ever', async () => {
    vi.useFakeTimers();

    mockFetch((url, options) => options.method === 'POST' && url.endsWith('/upload/session')
      ? { uploadId: 'abc', received: 0, chunkSize: 40 * MB }
      : { jobId: 1 });

    respond = () => ({ networkError: true });

    const uploading = api.upload(fakeFile({ size: 40 * MB }), { frameStart: 1, frameEnd: 1 });
    const settled = uploading.then(() => 'resolved', error => error);

    await vi.advanceTimersByTimeAsync(10000);

    expect(await settled).toBeInstanceOf(Error);
    expect(sent).toHaveLength(3);

    vi.useRealTimers();
  });

  it('and a refusal is not retried at all', async () => {
    mockFetch((url, options) => options.method === 'POST' && url.endsWith('/upload/session')
      ? { uploadId: 'abc', received: 0, chunkSize: 40 * MB }
      : { jobId: 1 });

    respond = () => ({ status: 413, body: { error: 'That chunk is too large' } });

    await expect(api.upload(fakeFile({ size: 40 * MB }), { frameStart: 1, frameEnd: 1 }))
      .rejects.toThrow('That chunk is too large');

    expect(sent).toHaveLength(1);
  });
});

describe('picking the same file again', () => {
  it('carries on from the byte the server already holds', async () => {
    localStorage.setItem('rendernet.upload', JSON.stringify({
      uploadId: 'earlier', name: 'scene.blend', size: 40 * MB, lastModified: 1000
    }));

    mockFetch(url => url.includes('/upload/session/earlier')
      ? { uploadId: 'earlier', received: 24 * MB, chunkSize: 16 * MB }
      : { jobId: 3 });

    respond = record => ({ status: 200, body: { received: offsetOf(record) + 16 * MB } });

    await api.upload(fakeFile({ size: 40 * MB }), { frameStart: 1, frameEnd: 1 });

    // Only the last 16MB is sent again, not the 24MB already there.
    expect(sent.map(offsetOf)).toEqual([24 * MB]);
  });

  it('while a different file of the same name starts afresh', async () => {
    localStorage.setItem('rendernet.upload', JSON.stringify({
      uploadId: 'earlier', name: 'scene.blend', size: 40 * MB, lastModified: 1000
    }));

    const opened = [];

    mockFetch((url, options) => {
      if (options.method === 'POST' && url.endsWith('/upload/session')) {
        opened.push(url);
        return { uploadId: 'fresh', received: 0, chunkSize: 40 * MB };
      }
      return { jobId: 4 };
    });

    respond = () => ({ status: 200, body: { received: 40 * MB } });

    // Same name and size, saved again since.
    await api.upload(fakeFile({ size: 40 * MB, lastModified: 2000 }),
      { frameStart: 1, frameEnd: 1 });

    expect(opened).toHaveLength(1);
    expect(sent.map(offsetOf)).toEqual([0]);
  });

  it('and a finished upload is not offered for resuming', async () => {
    mockFetch((url, options) => options.method === 'POST' && url.endsWith('/upload/session')
      ? { uploadId: 'abc', received: 0, chunkSize: 40 * MB }
      : { jobId: 5 });

    respond = () => ({ status: 200, body: { received: 40 * MB } });

    await api.upload(fakeFile({ size: 40 * MB }), { frameStart: 1, frameEnd: 1 });

    expect(localStorage.getItem('rendernet.upload')).toBeNull();
  });

  it('nor is a session the server has forgotten', async () => {
    localStorage.setItem('rendernet.upload', JSON.stringify({
      uploadId: 'swept', name: 'scene.blend', size: 40 * MB, lastModified: 1000
    }));

    vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
      if (String(url).includes('/upload/session/swept')) {
        return {
          ok: false,
          status: 404,
          headers: { get: () => 'application/json' },
          json: async () => ({ error: 'No such upload' }),
          text: async () => ''
        };
      }

      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => (options.method === 'POST' && String(url).endsWith('/upload/session')
          ? { uploadId: 'fresh', received: 0, chunkSize: 40 * MB }
          : { jobId: 6 }),
        text: async () => ''
      };
    }));

    respond = () => ({ status: 200, body: { received: 40 * MB } });

    const queued = await api.upload(fakeFile({ size: 40 * MB }), { frameStart: 1, frameEnd: 1 });

    expect(queued.jobId).toBe(6);
    expect(sent.map(offsetOf)).toEqual([0]);
  });
});
