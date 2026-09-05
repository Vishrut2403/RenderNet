import crypto from 'crypto';

// A link in a page and an <img> tag cannot carry an Authorization header, so a
// download URL has to carry something. A session token would be the whole
// account, sitting in browser history and in anything the URL is pasted into;
// this is one job, for a few minutes, and read-only.
const SECRET = crypto.randomBytes(32);
const TTL_MS = 10 * 60 * 1000;

function sign(payload) {
  return crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}

export function mintDownloadToken(jobId, username) {
  const expiresAt = Date.now() + TTL_MS;
  const payload = `${jobId}.${expiresAt}.${Buffer.from(username).toString('base64url')}`;

  return { token: `${payload}.${sign(payload)}`, expiresAt };
}

export function readDownloadToken(token) {
  if (typeof token !== 'string') return null;

  const parts = token.split('.');

  if (parts.length !== 4) return null;

  const [jobId, expiresAt, username, signature] = parts;
  const expected = sign(`${jobId}.${expiresAt}.${username}`);

  // Digests rather than the strings themselves: a signature of the same length
  // in characters can be a different length in bytes, and timingSafeEqual
  // throws on that rather than answering.
  const same = crypto.timingSafeEqual(
    crypto.createHash('sha256').update(signature).digest(),
    crypto.createHash('sha256').update(expected).digest()
  );

  if (!same) return null;

  if (!(Number(expiresAt) > Date.now())) return null;

  return { jobId: Number(jobId), username: Buffer.from(username, 'base64url').toString() };
}
