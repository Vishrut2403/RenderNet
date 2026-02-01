import express from 'express';
import { login, signup, changePassword, logout, requireAuth, requireAdmin, adminResetPassword } from '../auth.js';

const router = express.Router();

router.post('/login', (req, res) => {
  const { username, password } = req.body;
  
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  
  const result = login(username, password);
  
  if (result.success) {
    res.json(result);
  } else {
    res.status(401).json(result);
  }
});

router.post('/signup', (req, res) => {
  const { username, password } = req.body;
  
  const result = signup(username, password);
  
  if (result.success) {
    res.json(result);
  } else {
    res.status(400).json(result);
  }
});

router.post('/change-password', requireAuth, (req, res) => {
  const { oldPassword, newPassword } = req.body;
  const username = req.user.username;
  
  if (!oldPassword || !newPassword) {
    return res.status(400).json({ error: 'Old and new passwords required' });
  }
  
  const result = changePassword(username, oldPassword, newPassword);
  
  if (result.success) {
    res.json(result);
  } else {
    res.status(400).json(result);
  }
});

router.post('/logout', requireAuth, (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  logout(token);
  res.json({ success: true, message: 'Logged out successfully' });
});

router.get('/verify', (req, res) => {
  try {
    requireAuth(req, res, () => {
      res.json({
        valid: true,
        username: req.user.username,
        role: req.user.role
      });
    });
  } catch {
    res.json({ valid: false });
  }
});

router.post('/admin/reset-password', requireAuth, requireAdmin, (req, res) => {
  const { targetUsername, newPassword } = req.body;
  
  if (!targetUsername || !newPassword) {
    return res.status(400).json({ error: 'Username and new password required' });
  }
  
  const result = adminResetPassword(targetUsername, newPassword);
  
  if (result.success) {
    res.json(result);
  } else {
    res.status(400).json(result);
  }
});

export default router;