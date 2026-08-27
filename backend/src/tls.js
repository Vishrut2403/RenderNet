import fs from 'fs';

// Configured with a key and a certificate, or not at all. A half-configured
// pair stops the server rather than quietly serving plain HTTP: somebody who
// asked for TLS and did not get it would never know, and passwords, session
// tokens and scenes all cross the network either way.
export function tlsOptions() {
  const key = process.env.TLS_KEY;
  const cert = process.env.TLS_CERT;

  if (!key && !cert) return null;

  if (!key || !cert) {
    throw new Error('TLS needs both TLS_KEY and TLS_CERT; only one is set');
  }

  for (const file of [key, cert]) {
    if (!fs.existsSync(file)) throw new Error(`TLS file not found: ${file}`);
  }

  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}
