import express from 'express';
import { route } from '../utils/async-route.js';
import {
  login, signup, changePassword, logout, requireAuth, requireSession,
  requireAdmin, adminResetPassword, listUsers
} from '../auth.js';

const router = express.Router();

// A JSON body can carry any shape, and the layers below expect strings - an
// object reaches SQLite or bcrypt as a bind parameter and throws.
function credentials(...values) {
  return values.every(value => typeof value === 'string' && value.length > 0);
}

router.post('/login', route(async (req, res) => {
  const { username, password } = req.body;

  if (!credentials(username, password)) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const result = await login(username, password);

  if (result.success) {
    return res.json(result);
  }

  if (result.locked) {
    res.set('Retry-After', String(result.retryAfter));
    return res.status(429).json(result);
  }

  res.status(401).json(result);
}));

router.post('/signup', route(async (req, res) => {
  const { username, password, code } = req.body;

  if (!credentials(username, password)) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const result = await signup(username, password, code);
  
  if (result.success) {
    res.json(result);
  } else {
    res.status(400).json(result);
  }
}));

router.post('/change-password', requireSession, route(async (req, res) => {
  const { oldPassword, newPassword } = req.body;
  const username = req.user.username;
  
  if (!credentials(oldPassword, newPassword)) {
    return res.status(400).json({ error: 'Old and new passwords required' });
  }
  
  const result = await changePassword(username, oldPassword, newPassword);
  
  if (result.success) {
    res.json(result);
  } else {
    res.status(400).json(result);
  }
}));

router.post('/logout', requireSession, (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  logout(token);
  res.json({ success: true, message: 'Logged out successfully' });
});

router.get('/verify', requireSession, (req, res) => {
  res.json({
    valid: true,
    username: req.user.username,
    role: req.user.role,
    mustChangePassword: req.user.mustChangePassword
  });
});

router.get('/users', requireAuth, requireAdmin, (req, res) => {
  res.json({ users: listUsers() });
});

router.post('/admin/reset-password', requireAuth, requireAdmin, route(async (req, res) => {
  const { targetUsername, newPassword } = req.body;
  
  if (!credentials(targetUsername, newPassword)) {
    return res.status(400).json({ error: 'Username and new password required' });
  }
  
  const result = await adminResetPassword(targetUsername, newPassword);
  
  if (result.success) {
    res.json(result);
  } else {
    res.status(400).json(result);
  }
}));

export default router;