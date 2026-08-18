import crypto from 'crypto';
import fs from 'fs';
import bcrypt from 'bcrypt';
import {
  saveSession, loadSessions, deleteSession,
  saveUser, getUser, getAllUsers, countUsers
} from './db.js';
import { USERS_FILE } from './paths.js';

const BCRYPT_ROUNDS = 12;
const SESSION_DURATION = 24 * 60 * 60 * 1000;
const DEFAULT_ADMIN_PASSWORD = 'admin123';
const LOGIN_ATTEMPT_LIMIT = 5;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;

// Held in memory on purpose. The workstation is switched off nightly, and a
// lockout that outlived a reboot would mostly punish whoever mistyped last.
const failedLogins = new Map();

// Unknown usernames are counted too, so a lockout says nothing about whether
// the account exists.
function lockoutSecondsLeft(username) {
  const record = failedLogins.get(username);
  if (!record) return 0;

  if (Date.now() >= record.until) {
    failedLogins.delete(username);
    return 0;
  }

  return record.count >= LOGIN_ATTEMPT_LIMIT
    ? Math.ceil((record.until - Date.now()) / 1000)
    : 0;
}

function recordFailedLogin(username) {
  // Keys come from whatever was typed into the login box, so expired entries
  // are swept rather than left to pile up.
  if (failedLogins.size > 1000) {
    for (const [name, seen] of failedLogins) {
      if (Date.now() >= seen.until) failedLogins.delete(name);
    }
  }

  const record = failedLogins.get(username) ?? { count: 0 };

  record.count++;
  record.until = Date.now() + LOGIN_LOCKOUT_MS;
  failedLogins.set(username, record);
}

// Read lazily: index.js loads .env before this module, but tests set it per run.
function signupCode() {
  return process.env.SIGNUP_CODE;
}

function matchesSecret(provided, expected) {
  if (typeof provided !== 'string' || !expected) return false;

  // Digests rather than raw values, so length never has to match and the
  // comparison cannot throw on unexpected input.
  return crypto.timingSafeEqual(
    crypto.createHash('sha256').update(provided).digest(),
    crypto.createHash('sha256').update(expected).digest()
  );
}

function legacyHash(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

// Accounts created before the bcrypt migration still carry unsalted SHA-256
// hashes. They cannot be converted without the plaintext, so they are verified
// against the old scheme and re-hashed on the next successful login.
async function verifyPassword(password, user) {
  if (user.hashAlgo === 'sha256') {
    return legacyHash(password) === user.passwordHash;
  }
  return bcrypt.compare(password, user.passwordHash);
}

async function upgradeLegacyHash(user, password) {
  user.passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  user.hashAlgo = 'bcrypt';
  saveUser(user);
  console.log(`Upgraded password hash to bcrypt for user: ${user.username}`);
}

function migrateUsersFile() {
  if (!fs.existsSync(USERS_FILE)) return 0;

  let migrated = 0;

  for (const user of Object.values(JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')))) {
    if (getUser(user.username)) continue;

    saveUser({ ...user, hashAlgo: user.hashAlgo || 'sha256' });
    migrated++;
  }

  if (migrated) {
    // Renamed rather than deleted: keeps a backup, and makes it obvious the
    // file is no longer the authoritative store.
    fs.renameSync(USERS_FILE, `${USERS_FILE}.migrated`);
    console.log(`Migrated ${migrated} user(s) from ${USERS_FILE} into the database.`);
    console.log(`${USERS_FILE} renamed to ${USERS_FILE}.migrated; the database is now authoritative.`);
    console.log('Legacy password hashes upgrade to bcrypt on each user\'s next login.');
  }

  return migrated;
}

function seedAdmin() {
  if (countUsers() > 0) return;

  saveUser({
    username: 'admin',
    passwordHash: bcrypt.hashSync(DEFAULT_ADMIN_PASSWORD, BCRYPT_ROUNDS),
    hashAlgo: 'bcrypt',
    role: 'admin',
    createdAt: new Date().toISOString(),
    mustChangePassword: 1
  });

  console.warn('Created default admin account (admin / admin123).');
  console.warn('It cannot do anything until its password is changed at first login.');
}

// Installs that predate the flag can still be sitting on the seeded password,
// which is the one credential everybody already knows.
function usesDefaultPassword(user) {
  return user.hashAlgo === 'sha256'
    ? legacyHash(DEFAULT_ADMIN_PASSWORD) === user.passwordHash
    : bcrypt.compareSync(DEFAULT_ADMIN_PASSWORD, user.passwordHash);
}

function flagDefaultAdminPassword() {
  const admin = getUser('admin');

  if (!admin || admin.mustChangePassword) return;
  if (!usesDefaultPassword(admin)) return;

  admin.mustChangePassword = 1;
  saveUser(admin);
  console.warn('The admin account still uses the default password - a change is now required.');
}

migrateUsersFile();
seedAdmin();
flagDefaultAdminPassword();

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

const sessions = new Map();

for (const row of loadSessions()) {
  sessions.set(row.token, {
    username: row.username,
    role: row.role,
    expiresAt: row.expiresAt
  });
}

export async function login(username, password) {
  // Checked before any hashing: a locked-out name must not cost a bcrypt round
  // on the way to being refused.
  const lockedFor = lockoutSecondsLeft(username);

  if (lockedFor > 0) {
    return {
      success: false,
      locked: true,
      retryAfter: lockedFor,
      error: `Too many failed attempts. Try again in ${Math.ceil(lockedFor / 60)} minute(s).`
    };
  }

  const user = getUser(username);

  if (!user) {
    // Spend comparable time on an unknown username so response timing does not
    // reveal which accounts exist.
    await bcrypt.compare(password, '$2b$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv');
    recordFailedLogin(username);
    return { success: false, error: 'Invalid username or password' };
  }

  if (!await verifyPassword(password, user)) {
    recordFailedLogin(username);
    return { success: false, error: 'Invalid username or password' };
  }

  failedLogins.delete(username);

  if (user.hashAlgo === 'sha256') {
    await upgradeLegacyHash(user, password);
  }

  const token = generateToken();
  const session = {
    username: user.username,
    role: user.role,
    expiresAt: Date.now() + SESSION_DURATION
  };

  sessions.set(token, session);
  saveSession(token, session);

  console.log(`User logged in: ${username}`);

  return {
    success: true,
    token,
    username: user.username,
    role: user.role,
    mustChangePassword: !!user.mustChangePassword
  };
}

export async function signup(username, password, code) {
  if (!signupCode()) {
    return {
      success: false,
      error: 'Account creation is turned off. Ask an administrator to set SIGNUP_CODE.'
    };
  }

  if (!matchesSecret(code, signupCode())) {
    return { success: false, error: 'That signup code is not right' };
  }

  if (!username || username.length < 3) {
    return { success: false, error: 'Username must be at least 3 characters' };
  }

  if (!password || password.length < 6) {
    return { success: false, error: 'Password must be at least 6 characters' };
  }

  if (getUser(username)) {
    return { success: false, error: 'Username already exists' };
  }

  saveUser({
    username,
    passwordHash: await bcrypt.hash(password, BCRYPT_ROUNDS),
    hashAlgo: 'bcrypt',
    role: 'user',
    createdAt: new Date().toISOString()
  });

  console.log(`New user created: ${username}`);

  return { success: true, message: 'Account created successfully' };
}

export async function changePassword(username, oldPassword, newPassword) {
  const user = getUser(username);

  if (!user) {
    return { success: false, error: 'User not found' };
  }

  if (!await verifyPassword(oldPassword, user)) {
    return { success: false, error: 'Current password is incorrect' };
  }

  if (!newPassword || newPassword.length < 6) {
    return { success: false, error: 'New password must be at least 6 characters' };
  }

  user.passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  user.hashAlgo = 'bcrypt';
  user.passwordChangedAt = new Date().toISOString();
  user.mustChangePassword = 0;
  saveUser(user);

  console.log(`Password changed for user: ${username}`);

  return { success: true, message: 'Password changed successfully' };
}

export async function adminResetPassword(targetUsername, newPassword) {
  const user = getUser(targetUsername);

  if (!user) {
    return { success: false, error: 'User not found' };
  }

  if (!newPassword || newPassword.length < 6) {
    return { success: false, error: 'Password must be at least 6 characters' };
  }

  user.passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
  user.hashAlgo = 'bcrypt';
  user.passwordResetAt = new Date().toISOString();
  // The admin who set it knows it, so the owner has to replace it.
  user.mustChangePassword = 1;
  saveUser(user);

  console.log(`Password reset for user: ${targetUsername}`);

  return { success: true, message: 'Password reset successfully' };
}

export function listUsers() {
  return getAllUsers().map(({ passwordHash, hashAlgo, ...user }) => user);
}

export function verifyToken(token) {
  const session = sessions.get(token);

  if (!session) {
    return { valid: false, error: 'Invalid or expired session' };
  }

  if (Date.now() > session.expiresAt) {
    sessions.delete(token);
    deleteSession(token);
    return { valid: false, error: 'Session expired' };
  }

  return { valid: true, username: session.username, role: session.role };
}

export function logout(token) {
  sessions.delete(token);
  deleteSession(token);
  return { success: true };
}

// Establishes who is calling and nothing more. Used by the routes an account
// must still reach while it is locked out of everything else.
export function requireSession(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');

  if (!token) {
    return res.status(401).json({ error: 'No authentication token provided' });
  }

  const verification = verifyToken(token);

  if (!verification.valid) {
    return res.status(401).json({ error: verification.error });
  }

  req.user = {
    username: verification.username,
    role: verification.role,
    mustChangePassword: mustChangePassword(verification.username)
  };

  next();
}

// Looked up per request rather than stored on the session, so changing the
// password clears the lock immediately instead of at the next login.
export function mustChangePassword(username) {
  return !!getUser(username)?.mustChangePassword;
}

export function requireAuth(req, res, next) {
  requireSession(req, res, () => {
    if (req.user.mustChangePassword) {
      return res.status(403).json({
        error: 'Choose a new password before using RenderNet',
        mustChangePassword: true
      });
    }

    next();
  });
}

export function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}
