require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

/**
 * Builds the Express app without starting a server.
 *
 * `server.js` calls listen() for local/Railway use; `api/index.js` exports this
 * directly as a Vercel function, where there is no long-lived process to listen.
 */

// Fail loudly at boot rather than with confusing 500s on the first request.
const REQUIRED_ENV = ['JWT_SECRET', 'TURSO_DATABASE_URL', 'BLOB_READ_WRITE_TOKEN'];
const missing = REQUIRED_ENV.filter(name => !process.env[name]);
if (missing.length) {
  throw new Error(
    `Missing required environment variable(s): ${missing.join(', ')}. ` +
    'Set these in your .env file locally, or in the Vercel/Railway dashboard.'
  );
}

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static frontend. On Vercel these are served by the CDN instead
// (see vercel.json), so this only does work locally and on Railway.
app.use(express.static(path.join(__dirname, '../public')));

// API routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/files', require('./routes/files'));
app.use('/api/admin', require('./routes/admin'));

// Unknown API routes must 404 rather than fall through to the HTML handler.
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Extensionless HTML pages (/dashboard → dashboard.html), matching the
// cleanUrls behaviour Vercel applies to the static deployment.
app.get('*', (req, res, next) => {
  const file = path.join(__dirname, '../public', `${req.path}.html`);
  res.sendFile(file, err => (err ? next() : undefined));
});

// Fall back to the library page.
app.use((_req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Global error handler
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

module.exports = app;
