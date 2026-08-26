import cors from 'cors';

// The app is served by this process from FRONTEND_DIST, so everything it needs
// comes from the same origin. Styles are the one exception: the boot message in
// index.html is inline, and the progress bar sets its own width.
const POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "form-action 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'"
].join('; ');

export function securityHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy', POLICY);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
}

function allowedOrigins() {
  return (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);
}

// A browser only asks about cross-origin requests, and the UI this server ships
// is same-origin. Anything else has to be named, so a page on another site
// cannot call the API with whatever the visitor's browser will send.
export function crossOrigin() {
  const allowed = allowedOrigins();

  if (allowed.length === 0) return (req, res, next) => next();

  console.log(`Cross-origin requests allowed from: ${allowed.join(', ')}`);

  return cors({
    origin: (origin, callback) => callback(null, !origin || allowed.includes(origin))
  });
}
