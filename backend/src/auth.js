import crypto from 'crypto';
import fs from 'fs';

const USERS_FILE = 'users.json';

function initUsersFile() {
  if (!fs.existsSync(USERS_FILE)) {
    const defaultUsers = {
      admin: {
        username: 'admin',
        passwordHash: hashPassword('admin123'),
        role: 'admin',
        createdAt: new Date().toISOString()
      }
    };
    fs.writeFileSync(USERS_FILE, JSON.stringify(defaultUsers, null, 2));
  }
}

function loadUsers() {
  if (!fs.existsSync(USERS_FILE)) {
    initUsersFile();
  }
  const data = fs.readFileSync(USERS_FILE, 'utf8');
  return JSON.parse(data);
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

const sessions = new Map(); 

const SESSION_DURATION = 24 * 60 * 60 * 1000;

export function login(username, password) {
  const users = loadUsers();
  const user = users[username];
  
  if (!user) {
    return { success: false, error: 'Invalid username or password' };
  }
  
  const passwordHash = hashPassword(password);
  if (passwordHash !== user.passwordHash) {
    return { success: false, error: 'Invalid username or password' };
  }
  
  const token = generateToken();
  const expiresAt = Date.now() + SESSION_DURATION;
  
  sessions.set(token, {
    username: user.username,
    role: user.role,
    expiresAt
  });
  
  console.log(`User logged in: ${username}`);
  
  return {
    success: true,
    token,
    username: user.username,
    role: user.role
  };
}
export function signup(username, password) {
  if (!username || username.length < 3) {
    return { success: false, error: 'Username must be at least 3 characters' };
  }
  
  if (!password || password.length < 6) {
    return { success: false, error: 'Password must be at least 6 characters' };
  }
  
  const users = loadUsers();
  
  if (users[username]) {
    return { success: false, error: 'Username already exists' };
  }
  
  users[username] = {
    username,
    passwordHash: hashPassword(password),
    role: 'user',
    createdAt: new Date().toISOString()
  };
  
  saveUsers(users);
  console.log(`New user created: ${username}`);
  
  return { success: true, message: 'Account created successfully' };
}


export function changePassword(username, oldPassword, newPassword) {
  const users = loadUsers();
  const user = users[username];
  
  if (!user) {
    return { success: false, error: 'User not found' };
  }
  
  const oldPasswordHash = hashPassword(oldPassword);
  if (oldPasswordHash !== user.passwordHash) {
    return { success: false, error: 'Current password is incorrect' };
  }
  
  if (!newPassword || newPassword.length < 6) {
    return { success: false, error: 'New password must be at least 6 characters' };
  }
  
  user.passwordHash = hashPassword(newPassword);
  user.passwordChangedAt = new Date().toISOString();
  
  saveUsers(users);
  console.log(`Password changed for user: ${username}`);
  
  return { success: true, message: 'Password changed successfully' };
}

export function verifyToken(token) {
  const session = sessions.get(token);
  
  if (!session) {
    return { valid: false, error: 'Invalid or expired session' };
  }
  
  if (Date.now() > session.expiresAt) {
    sessions.delete(token);
    return { valid: false, error: 'Session expired' };
  }
  
  return {
    valid: true,
    username: session.username,
    role: session.role
  };
}

export function logout(token) {
  sessions.delete(token);
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

initUsersFile();

export function listUsers() {
  return Object.values(loadUsers()).map(({ passwordHash, ...user }) => user);
}

export function adminResetPassword(targetUsername, newPassword) {
  const users = loadUsers();
  
  const user = users[targetUsername];
  if (!user) {
    return { success: false, error: 'User not found' };
  }
  
  if (!newPassword || newPassword.length < 6) {
    return { success: false, error: 'Password must be at least 6 characters' };
  }
  
  user.passwordHash = hashPassword(newPassword);
  user.passwordResetAt = new Date().toISOString();
  
  saveUsers(users);
  console.log(`Password reset for user: ${targetUsername}`);
  
  return { success: true, message: 'Password reset successfully' };
}