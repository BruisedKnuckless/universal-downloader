const express = require('express');
const path = require('path');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { handleUpload } = require('@vercel/blob/client');
const { getDownloadUrl } = require('@vercel/blob');
const { run, all, one } = require('../db');
const { authRequired } = require('../middleware/auth');
const blob = require('../storage/blob');

const router = express.Router();

const TOTAL_STORAGE_LIMIT = (parseInt(process.env.TOTAL_STORAGE_LIMIT_MB) || 1024) * 1024 * 1024;

// ── Helpers ─────────────────────────────────────────────────────────────────
/** Bytes still available under the total community storage quota. */
async function remainingStorage() {
  const usage = await one('SELECT COALESCE(SUM(size_bytes), 0) as total_used FROM files');
  return TOTAL_STORAGE_LIMIT - (usage ? usage.total_used : 0);
}

function autoTag(mimeType, filename) {
  const ext = path.extname(filename).toLowerCase();
  if (mimeType.startsWith('image/')) return 'Images';
  if (mimeType.startsWith('audio/')) return 'Audio';
  if (mimeType.startsWith('video/')) return 'Video';
  if (['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz'].includes(ext)) return 'Archives';
  if (['.js', '.ts', '.py', '.java', '.c', '.cpp', '.go', '.rs', '.rb', '.php', '.html', '.css', '.json', '.xml', '.yaml', '.yml', '.sh', '.bat', '.ps1'].includes(ext)) return 'Code';
  if (['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.md', '.rtf', '.odt', '.csv'].includes(ext)) return 'Documents';
  return 'Other';
}

// ── Storage info (public) ───────────────────────────────────────────────────
router.get('/storage-info', async (_req, res) => {
  try {
    const result = await one('SELECT COALESCE(SUM(size_bytes), 0) as total_used FROM files');
    const totalUsed = result ? result.total_used : 0;
    res.json({
      totalLimit: TOTAL_STORAGE_LIMIT,
      totalUsed: totalUsed,
      remaining: TOTAL_STORAGE_LIMIT - totalUsed
    });
  } catch (err) {
    console.error('Storage info error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── All unique tags (public) ────────────────────────────────────────────────
router.get('/tags', async (_req, res) => {
  try {
    const rows = await all('SELECT tags FROM files');
    const tagSet = new Set();
    rows.forEach(r => {
      JSON.parse(r.tags || '[]').forEach(t => tagSet.add(t));
    });
    res.json({ tags: Array.from(tagSet).sort() });
  } catch (err) {
    console.error('Get tags error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── List files (public, paginated, searchable, filterable) ──────────────────
router.get('/', async (req, res) => {
  try {
    const { search, tag } = req.query;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 24));
    const offset = (page - 1) * limit;
    const params = [];
    const conditions = [];

    if (search) {
      conditions.push('f.original_name LIKE ?');
      params.push(`%${search}%`);
    }
    if (tag) {
      conditions.push('f.tags LIKE ?');
      params.push(`%"${tag}"%`);
    }

    const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : '';

    const countResult = await one(`SELECT COUNT(*) as total FROM files f${where}`, params);
    const total = countResult ? countResult.total : 0;

    const files = await all(`
      SELECT f.*, u.username AS uploader_name
      FROM files f JOIN users u ON f.user_id = u.id
      ${where}
      ORDER BY f.uploaded_at DESC
      LIMIT ? OFFSET ?
    `, [...params, limit, offset]);

    res.json({
      files: files.map(f => ({ ...f, tags: JSON.parse(f.tags || '[]') })),
      total,
      page,
      totalPages: Math.ceil(total / limit)
    });
  } catch (err) {
    console.error('List files error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Upload token (auth required) ────────────────────────────────────────────
/**
 * Issues a short-lived token so the browser can upload straight to Vercel Blob.
 *
 * The file never passes through this server, which is what keeps large uploads
 * working on Vercel (functions cap request bodies at 4.5 MB). The storage quota
 * is enforced by capping the token at the bytes remaining, the same job the
 * multer `fileSize` limit used to do.
 */
router.post('/upload-token', async (req, res) => {
  try {
    const jsonResponse = await handleUpload({
      body: req.body,
      request: req,
      token: process.env.BLOB_READ_WRITE_TOKEN,

      onBeforeGenerateToken: async (_pathname, clientPayload) => {
        // Authenticate here rather than with middleware: the upload-completed
        // callback hits this same route without the user's Authorization header.
        const header = req.headers.authorization;
        if (!header || !header.startsWith('Bearer ')) {
          throw new Error('Authentication required');
        }
        const user = jwt.verify(header.split(' ')[1], process.env.JWT_SECRET);

        const remaining = await remainingStorage();
        if (remaining <= 0) {
          throw new Error('Storage limit reached. Cannot upload more files.');
        }

        // Never trust the client payload — it is attacker-controlled.
        let tags = [];
        try {
          const parsed = JSON.parse(clientPayload || '{}');
          if (Array.isArray(parsed.tags)) {
            tags = parsed.tags.filter(t => typeof t === 'string').slice(0, 10);
          }
        } catch (_) { /* keep tags empty */ }

        return {
          // Blob itself rejects anything bigger, so an oversized file is
          // stopped mid-stream instead of after it lands.
          maximumSizeInBytes: remaining,
          // Random suffix stops one user overwriting another user's pathname.
          addRandomSuffix: true,
          tokenPayload: JSON.stringify({ userId: user.id, tags })
        };
      },

      // Not relied upon: it cannot reach localhost and needs an explicit
      // callbackUrl off Vercel. The /confirm route below is the real path;
      // this exists so Blob gets a 200 and stops retrying.
      onUploadCompleted: async () => {}
    });

    res.json(jsonResponse);
  } catch (err) {
    console.error('Upload token error:', err);
    res.status(400).json({ error: err.message });
  }
});

// ── Confirm an upload (auth required) ───────────────────────────────────────
/**
 * Records a blob that the browser finished uploading.
 *
 * Size and content type come from Blob itself rather than the client, and the
 * quota is re-checked here; a file that would overrun it is deleted again.
 */
router.post('/confirm', authRequired, async (req, res) => {
  const { url, originalName, tags } = req.body || {};
  if (!url || !originalName) {
    return res.status(400).json({ error: 'url and originalName are required' });
  }

  try {
    // Authoritative metadata — never trust a client-reported size.
    const meta = await blob.head(url);
    if (!meta) return res.status(404).json({ error: 'Uploaded file not found in storage' });

    const remaining = await remainingStorage();
    if (meta.size > remaining) {
      await blob.remove(url);
      return res.status(413).json({
        error: `File too large. Only ${(remaining / 1024 / 1024).toFixed(2)} MB of storage remaining.`
      });
    }

    const mimeType = meta.contentType || 'application/octet-stream';
    const category = autoTag(mimeType, originalName);
    const userTags = Array.isArray(tags) ? tags.filter(t => t && t !== category) : [];
    const allTags = [category, ...userTags];

    const id = uuidv4();
    await run(
      `INSERT INTO files (id, original_name, stored_name, blob_url, mime_type, size_bytes, tags, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, originalName, meta.pathname, meta.url, mimeType, meta.size, JSON.stringify(allTags), req.user.id]
    );

    const file = await one(
      'SELECT f.*, u.username AS uploader_name FROM files f JOIN users u ON f.user_id = u.id WHERE f.id = ?',
      [id]
    );
    res.status(201).json({ file: { ...file, tags: JSON.parse(file.tags || '[]') } });
  } catch (err) {
    // A duplicate stored_name means this blob is already recorded — most likely
    // a double-submit, or someone claiming a blob that is not theirs.
    if (String(err.message || '').includes('UNIQUE constraint failed')) {
      return res.status(409).json({ error: 'This file has already been recorded' });
    }
    console.error('Confirm upload error:', err);
    if (blob.isConfigError(err)) {
      return res.status(503).json({ error: blob.CONFIG_ERROR_MESSAGE });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Download (public) ──────────────────────────────────────────────────────
router.get('/:id/download', async (req, res) => {
  try {
    const file = await one('SELECT * FROM files WHERE id = ?', [req.params.id]);
    if (!file) return res.status(404).json({ error: 'File not found' });

    await run('UPDATE files SET download_count = download_count + 1 WHERE id = ?', [file.id]);

    // Redirect rather than stream: Vercel caps response bodies at 4.5 MB, so a
    // large file cannot be proxied through the server at all.
    res.redirect(getDownloadUrl(file.blob_url));
  } catch (err) {
    console.error('Download error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Preview / inline view (public) ─────────────────────────────────────────
router.get('/:id/preview', async (req, res) => {
  try {
    const file = await one('SELECT * FROM files WHERE id = ?', [req.params.id]);
    if (!file) return res.status(404).json({ error: 'File not found' });

    // Plain blob URL is served inline — keeps the Xbox Edge workaround working.
    res.redirect(file.blob_url);
  } catch (err) {
    console.error('Preview error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Delete (auth required, owner only) ──────────────────────────────────────
router.delete('/:id', authRequired, async (req, res) => {
  try {
    const file = await one('SELECT * FROM files WHERE id = ?', [req.params.id]);
    if (!file) return res.status(404).json({ error: 'File not found' });
    if (file.user_id !== req.user.id) return res.status(403).json({ error: 'You can only delete your own files' });

    await blob.remove(file.blob_url);
    await run('DELETE FROM files WHERE id = ?', [file.id]);

    res.json({ message: 'File deleted successfully' });
  } catch (err) {
    console.error('Delete error:', err);
    if (blob.isConfigError(err)) {
      return res.status(503).json({ error: blob.CONFIG_ERROR_MESSAGE });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
