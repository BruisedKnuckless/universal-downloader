const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const UPLOADS_DIR = path.join(__dirname, '../../uploads');

// Ensure uploads directory exists
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  }
});

/**
 * Builds a multer instance capped at `maxBytes` for a single request.
 * There is no fixed per-file limit — callers pass the storage remaining so
 * multer aborts an oversized stream instead of filling the volume.
 */
function uploadWithLimit(maxBytes) {
  return multer({
    storage,
    limits: { fileSize: maxBytes }
  });
}

module.exports = { uploadWithLimit, UPLOADS_DIR };
