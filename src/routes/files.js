const express = require('express');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { getDB, saveDB } = require('../db/init');
const { authRequired } = require('../middleware/auth');
const { upload, UPLOADS_DIR } = require('../middleware/upload');

const router = express.Router();

const TOTAL_STORAGE_LIMIT = (parseInt(process.env.TOTAL_STORAGE_LIMIT_MB) || 1024) * 1024 * 1024;

// ── Helpers ─────────────────────────────────────────────────────────────────
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
router.get('/storage-info', (_req, res) => {
  const result = queryOne('SELECT COALESCE(SUM(size_bytes), 0) as total_used FROM files');
  const totalUsed = result ? result.total_used : 0;
  res.json({
    totalLimit: TOTAL_STORAGE_LIMIT,
    totalUsed: totalUsed,
    remaining: TOTAL_STORAGE_LIMIT - totalUsed
  });
});

// ── All unique tags (public) ────────────────────────────────────────────────
router.get('/tags', (_req, res) => {
  try {
    const rows = queryAll('SELECT tags FROM files');
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
router.get('/', (req, res) => {
  try {
    const { search, tag, page = 1, limit = 24 } = req.query;
    const offset = (Math.max(1, parseInt(page)) - 1) * parseInt(limit);
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

    const countResult = queryOne(`SELECT COUNT(*) as total FROM files f${where}`, params);
    const total = countResult ? countResult.total : 0;

    const files = queryAll(`
      SELECT f.*, u.username AS uploader_name
      FROM files f JOIN users u ON f.user_id = u.id
      ${where}
      ORDER BY f.uploaded_at DESC
      LIMIT ? OFFSET ?
    `, [...params, parseInt(limit), offset]);

    res.json({
      files: files.map(f => ({ ...f, tags: JSON.parse(f.tags || '[]') })),
      total,
      page: parseInt(page),
      totalPages: Math.ceil(total / parseInt(limit))
    });
  } catch (err) {
    console.error('List files error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Upload (auth required) ─────────────────────────────────────────────────
router.post('/upload', authRequired, upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });

    // Check storage quota
    const usageResult = queryOne('SELECT COALESCE(SUM(size_bytes), 0) as total_used FROM files');
    const totalUsed = usageResult ? usageResult.total_used : 0;
    if (totalUsed + req.file.size > TOTAL_STORAGE_LIMIT) {
      fs.unlinkSync(req.file.path);
      return res.status(413).json({ error: 'Storage limit reached. Cannot upload more files.' });
    }

    // Build tags: auto-detected category + user-supplied custom tags
    const category = autoTag(req.file.mimetype, req.file.originalname);
    let userTags = [];
    try { userTags = req.body.tags ? JSON.parse(req.body.tags) : []; } catch (_) { userTags = []; }
    const tags = [category, ...userTags.filter(t => t && t !== category)];

    const id = uuidv4();
    const db = getDB();
    db.run(
      'INSERT INTO files (id, original_name, stored_name, mime_type, size_bytes, tags, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, req.file.originalname, req.file.filename, req.file.mimetype, req.file.size, JSON.stringify(tags), req.user.id]
    );
    saveDB();

    const file = queryOne('SELECT f.*, u.username AS uploader_name FROM files f JOIN users u ON f.user_id = u.id WHERE f.id = ?', [id]);
    res.status(201).json({ file: { ...file, tags: JSON.parse(file.tags || '[]') } });
  } catch (err) {
    console.error('Upload error:', err);
    if (req.file) try { fs.unlinkSync(req.file.path); } catch (_) {}
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Download (public) ──────────────────────────────────────────────────────
router.get('/:id/download', (req, res) => {
  try {
    const file = queryOne('SELECT * FROM files WHERE id = ?', [req.params.id]);
    if (!file) return res.status(404).json({ error: 'File not found' });

    const filePath = path.join(UPLOADS_DIR, file.stored_name);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File missing from storage' });

    const db = getDB();
    db.run('UPDATE files SET download_count = download_count + 1 WHERE id = ?', [file.id]);
    saveDB();

    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.original_name)}"`);
    res.setHeader('Content-Type', file.mime_type);
    res.sendFile(filePath);
  } catch (err) {
    console.error('Download error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── Delete (auth required, owner only) ──────────────────────────────────────
router.delete('/:id', authRequired, (req, res) => {
  try {
    const file = queryOne('SELECT * FROM files WHERE id = ?', [req.params.id]);
    if (!file) return res.status(404).json({ error: 'File not found' });
    if (file.user_id !== req.user.id) return res.status(403).json({ error: 'You can only delete your own files' });

    const filePath = path.join(UPLOADS_DIR, file.stored_name);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

    const db = getDB();
    db.run('DELETE FROM files WHERE id = ?', [file.id]);
    saveDB();

    res.json({ message: 'File deleted successfully' });
  } catch (err) {
    console.error('Delete error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
