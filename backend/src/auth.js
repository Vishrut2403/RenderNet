import crypto from 'crypto';
import fs from 'fs';
import bcrypt from 'bcrypt';
import {
  saveSession, loadSessions, deleteSession,
  saveUser, getUser, getAllUsers, countUsers
} from './db.js';

const USERS_FILE = 'users.json';
const BCRYPT_ROUNDS = 12;
const SESSION_DURATION = 24 * 60 * 60 * 1000;

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
    passwordHash: bcrypt.hashSync('admin123', BCRYPT_ROUNDS),
    hashAlgo: 'bcrypt',
    role: 'admin',
    createdAt: new Date().toISOString()
  });

  console.warn('Created default admin account (admin / admin123) - change this password.');
}

migrateUsersFile();
seedAdmin();

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
  const user = getUser(username);

  if (!user) {
    // Spend comparable time on an unknown username so response timing does not
    // reveal which accounts exist.
    await bcrypt.compare(password, '$2b$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv');
    return { success: false, error: 'Invalid username or password' };
  }

  if (!await verifyPassword(password, user)) {
    return { success: false, error: 'Invalid username or password' };
  }

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

  return { success: true, token, username: user.username, role: user.role };
}

export async function signup(username, password) {
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

export function requireAuth(req, res, next) {
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
    role: verification.role
  };

  next();
}

export function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}
