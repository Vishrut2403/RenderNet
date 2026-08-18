import express from 'express';
import {
  login, signup, changePassword, logout, requireAuth, requireSession,
  requireAdmin, adminResetPassword, listUsers
} from '../auth.js';

const router = express.Router();

router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  
  const result = await login(username, password);
  
  if (result.success) {
    res.json(result);
  } else {
    res.status(401).json(result);
  }
});

router.post('/signup', async (req, res) => {
  const { username, password, code } = req.body;

  const result = await signup(username, password, code);
  
  if (result.success) {
    res.json(result);
  } else {
    res.status(400).json(result);
  }
});

router.post('/change-password', requireSession, async (req, res) => {
  const { oldPassword, newPassword } = req.body;
  const username = req.user.username;
  
  if (!oldPassword || !newPassword) {
    return res.status(400).json({ error: 'Old and new passwords required' });
  }
  
  const result = await changePassword(username, oldPassword, newPassword);
  
  if (result.success) {
    res.json(result);
  } else {
    res.status(400).json(result);
  }
});

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

router.post('/admin/reset-password', requireAuth, requireAdmin, async (req, res) => {
  const { targetUsername, newPassword } = req.body;
  
  if (!targetUsername || !newPassword) {
    return res.status(400).json({ error: 'Username and new password required' });
  }
  
  const result = await adminResetPassword(targetUsername, newPassword);
  
  if (result.success) {
    res.json(result);
  } else {
    res.status(400).json(result);
  }
});

export default router;