const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { run, all, one } = require('../db');
const { authRequired } = require('../middleware/auth');
const blob = require('../storage/blob');

const router = express.Router();

// ── Register ────────────────────────────────────────────────────────────────
router.post('/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({ error: 'All fields are required' });
    }
    if (username.length < 3 || username.length > 30) {
      return res.status(400).json({ error: 'Username must be 3–30 characters' });
    }
    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
      return res.status(400).json({ error: 'Username can only contain letters, numbers, and underscores' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    // Compare usernames case-insensitively, since that is how they are stored.
    const existing = await one(
      'SELECT id FROM users WHERE email = ? OR LOWER(username) = ?',
      [email.toLowerCase(), username.toLowerCase()]
    );
    if (existing) {
      return res.status(409).json({ error: 'Email or username already taken' });
    }

    const id = uuidv4();
    const passwordHash = bcrypt.hashSync(password, 12);

    await run('INSERT INTO users (id, username, email, password_hash) VALUES (?, ?, ?, ?)',
      [id, username, email.toLowerCase(), passwordHash]);

    const token = jwt.sign({ id, username, email: email.toLowerCase() }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.status(201).json({ token, user: { id, username, email: email.toLowerCase() } });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Login ───────────────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const user = await one('SELECT * FROM users WHERE email = ?', [email.toLowerCase()]);
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );
    res.json({ token, user: { id: user.id, username: user.username, email: user.email } });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Get current user ────────────────────────────────────────────────────────
router.get('/me', authRequired, async (req, res) => {
  try {
    const user = await one('SELECT id, username, email, created_at FROM users WHERE id = ?', [req.user.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ user });
  } catch (err) {
    console.error('Get me error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Delete account (auth required — deletes user + all their files) ─────────
router.delete('/account', authRequired, async (req, res) => {
  try {
    const userId = req.user.id;

    // 1. Get all files belonging to this user
    const files = await all('SELECT blob_url FROM files WHERE user_id = ?', [userId]);

    // 2. Delete the stored blobs
    await blob.removeMany(files.map(f => f.blob_url));

    // 3. Delete file records, then the user
    await run('DELETE FROM files WHERE user_id = ?', [userId]);
    await run('DELETE FROM users WHERE id = ?', [userId]);

    res.json({ message: 'Account and all files deleted successfully' });
  } catch (err) {
    console.error('Delete account error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
