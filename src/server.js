require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { initDB } = require('./db/init');

async function start() {
  // Initialize database first
  await initDB();

  const app = express();
  const PORT = process.env.PORT || 3000;

  // Ensure uploads directory exists
  const uploadsDir = path.join(__dirname, '../uploads');
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }

  // Middleware
  app.use(cors());
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Serve static frontend
  app.use(express.static(path.join(__dirname, '../public')));

  // API routes
  app.use('/api/auth', require('./routes/auth'));
  app.use('/api/files', require('./routes/files'));
  app.use('/api/admin', require('./routes/admin'));

  // SPA-style fallback for HTML pages
  app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
      res.sendFile(path.join(__dirname, '../public/index.html'));
    }
  });

  // Global error handler (multer size errors, etc.)
  app.use((err, _req, res, _next) => {
    console.error('Unhandled error:', err);
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        error: `File too large. Maximum size is ${process.env.MAX_FILE_SIZE_MB || 100} MB`
      });
    }
    res.status(500).json({ error: 'Internal server error' });
  });

  app.listen(PORT, () => {
    console.log(`\n  🚀  Universal Downloader running at http://localhost:${PORT}\n`);
  });
}

start().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
