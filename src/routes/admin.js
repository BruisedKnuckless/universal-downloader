const express = require('express');
const { run, all, one } = require('../db');
const blob = require('../storage/blob');

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

// ── GET /api/admin/users — list all users with file stats ───────────────────
router.get('/users', async (_req, res) => {
  try {
    const users = await all(`
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
router.delete('/users/:id', async (req, res) => {
  try {
    const userId = req.params.id;

    // Check user exists
    const user = await one('SELECT username FROM users WHERE id = ?', [userId]);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Get their files
    const files = await all('SELECT blob_url FROM files WHERE user_id = ?', [userId]);

    // Delete the stored blobs
    await blob.removeMany(files.map(f => f.blob_url));

    // Delete DB records
    await run('DELETE FROM files WHERE user_id = ?', [userId]);
    await run('DELETE FROM users WHERE id = ?', [userId]);

    res.json({
      message: `User "${user.username}" deleted`,
      filesRemoved: files.length,
      dbRecordsRemoved: files.length
    });
  } catch (err) {
    console.error('Admin delete user error:', err);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

// ── POST /api/admin/cleanup — remove orphaned blobs ─────────────────────────
router.post('/cleanup', async (_req, res) => {
  try {
    // Every blob the database knows about
    const dbFiles = await all('SELECT stored_name FROM files');
    const dbNames = new Set(dbFiles.map(f => f.stored_name));

    // Everything actually sitting in the blob store
    const stored = await blob.listAll();

    const orphans = stored.filter(b => !dbNames.has(b.pathname));
    const freedBytes = orphans.reduce((sum, b) => sum + (b.size || 0), 0);

    await blob.removeMany(orphans.map(b => b.url));

    res.json({
      message: `Cleaned up ${orphans.length} orphaned files`,
      freedMB: (freedBytes / 1024 / 1024).toFixed(2)
    });
  } catch (err) {
    console.error('Admin cleanup error:', err);
    if (blob.isConfigError(err)) {
      return res.status(503).json({ error: blob.CONFIG_ERROR_MESSAGE });
    }
    res.status(500).json({ error: 'Cleanup failed: ' + err.message });
  }
});

module.exports = router;
