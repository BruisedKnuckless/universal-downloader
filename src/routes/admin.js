const express = require('express');
const fs = require('fs');
const path = require('path');
const { getDB, saveDB } = require('../db/init');
const { UPLOADS_DIR } = require('../middleware/upload');

const router = express.Router();

// ── Admin secret check ──────────────────────────────────────────────────────
const ADMIN_SECRET = process.env.ADMIN_SECRET || '11-05-06';

function adminRequired(req, res, next) {
  const secret = req.headers['x-admin-secret'];
  if (!secret || secret !== ADMIN_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

router.use(adminRequired);

// ── Helpers ─────────────────────────────────────────────────────────────────
function queryAll(sql, params = []) {
  const db = getDB();
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    const cols = stmt.getColumnNames();
    const vals = stmt.get();
    const row = {};
    cols.forEach((c, i) => row[c] = vals[i]);
    rows.push(row);
  }
  stmt.free();
  return rows;
}

function queryOne(sql, params = []) {
  const db = getDB();
  const stmt = db.prepare(sql);
  stmt.bind(params);
  let row = null;
  if (stmt.step()) {
    const cols = stmt.getColumnNames();
    const vals = stmt.get();
    row = {};
    cols.forEach((c, i) => row[c] = vals[i]);
  }
  stmt.free();
  return row;
}

// ── GET /api/admin/users — list all users with file stats ───────────────────
router.get('/users', (_req, res) => {
  try {
    const users = queryAll(`
      SELECT 
        u.id, u.username, u.email, u.created_at,
        COUNT(f.id) as file_count,
        COALESCE(SUM(f.size_bytes), 0) as total_bytes
      FROM users u
      LEFT JOIN files f ON u.id = f.user_id
      GROUP BY u.id
      ORDER BY u.created_at DESC
    `);
    res.json({ users });
  } catch (err) {
    console.error('Admin list users error:', err);
    res.status(500).json({ error: 'Failed to list users' });
  }
});

// ── DELETE /api/admin/users/:id — nuke a user + their files ─────────────────
router.delete('/users/:id', (req, res) => {
  try {
    const userId = req.params.id;
    const db = getDB();

    // Check user exists
    const user = queryOne('SELECT username FROM users WHERE id = ?', [userId]);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Get their files
    const files = queryAll('SELECT stored_name FROM files WHERE user_id = ?', [userId]);

    // Delete physical files from disk
    let deletedFiles = 0;
    files.forEach(f => {
      const filePath = path.join(UPLOADS_DIR, f.stored_name);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        deletedFiles++;
      }
    });

    // Delete DB records
    db.run('DELETE FROM files WHERE user_id = ?', [userId]);
    db.run('DELETE FROM users WHERE id = ?', [userId]);
    saveDB();

    res.json({
      message: `User "${user.username}" deleted`,
      filesRemoved: deletedFiles,
      dbRecordsRemoved: files.length
    });
  } catch (err) {
    console.error('Admin delete user error:', err);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

// ── POST /api/admin/cleanup — remove orphaned physical files ────────────────
router.post('/cleanup', (_req, res) => {
  try {
    // Get all stored_names from DB
    const dbFiles = queryAll('SELECT stored_name FROM files');
    const dbNames = new Set(dbFiles.map(f => f.stored_name));

    // Scan uploads dir
    const diskFiles = fs.readdirSync(UPLOADS_DIR).filter(f => f !== 'data.db');

    let removed = 0;
    let freedBytes = 0;
    diskFiles.forEach(filename => {
      if (!dbNames.has(filename)) {
        const filePath = path.join(UPLOADS_DIR, filename);
        const stat = fs.statSync(filePath);
        freedBytes += stat.size;
        fs.unlinkSync(filePath);
        removed++;
      }
    });

    res.json({
      message: `Cleaned up ${removed} orphaned files`,
      freedMB: (freedBytes / 1024 / 1024).toFixed(2)
    });
  } catch (err) {
    console.error('Admin cleanup error:', err);
    res.status(500).json({ error: 'Cleanup failed' });
  }
});

module.exports = router;
