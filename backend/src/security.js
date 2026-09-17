import cors from 'cors';

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

const HSTS = process.env.TLS_KEY && process.env.TLS_CERT
  ? 'max-age=31536000'
  : null;

export function securityHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy', POLICY);

  if (HSTS) res.setHeader('Strict-Transport-Security', HSTS);
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

export function crossOrigin() {
  const allowed = allowedOrigins();

  if (allowed.length === 0) return (req, res, next) => next();

  console.log(`Cross-origin requests allowed from: ${allowed.join(', ')}`);

  return cors({
    origin: (origin, callback) => callback(null, !origin || allowed.includes(origin))
  });
}
