#!/usr/bin/env node
/**
 * One-time migration: local sql.js database + uploads/ directory → Turso + Vercel Blob.
 *
 * Run this once against the old Railway volume (or a copy of it) before cutting
 * over to the shared backend. It is idempotent — users and files already present
 * in Turso are skipped, so a partial run can simply be repeated.
 *
 *   node scripts/migrate-to-cloud.js [--dry-run] [--uploads-dir <path>]
 *
 * Requires TURSO_DATABASE_URL, TURSO_AUTH_TOKEN and BLOB_READ_WRITE_TOKEN.
 */
require('dotenv').config();

const fs = require('fs');
const path = require('path');
// sql.js is kept as a runtime dependency purely so this script can run inside the
// Railway container, where the old volume is actually mounted.
const initSqlJs = require('sql.js');
const { put } = require('@vercel/blob');
const { run, one, ensureSchema } = require('../src/db');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const dirFlag = args.indexOf('--uploads-dir');
const UPLOADS_DIR = dirFlag !== -1
  ? path.resolve(args[dirFlag + 1])
  : path.join(__dirname, '../uploads');
const DB_PATH = path.join(UPLOADS_DIR, 'data.db');

function rowsOf(db, sql) {
  const stmt = db.prepare(sql);
  const rows = [];
  while (stmt.step()) {
    const cols = stmt.getColumnNames();
    const vals = stmt.get();
    const row = {};
    cols.forEach((c, i) => { row[c] = vals[i]; });
    rows.push(row);
  }
  stmt.free();
  return rows;
}

async function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`No database found at ${DB_PATH}`);
    console.error('Point at the old volume with --uploads-dir <path>');
    process.exit(1);
  }

  console.log(`Source : ${DB_PATH}`);
  console.log(`Target : ${process.env.TURSO_DATABASE_URL}`);
  if (DRY_RUN) console.log('Mode   : DRY RUN — nothing will be written\n');

  const SQL = await initSqlJs();
  const legacy = new SQL.Database(fs.readFileSync(DB_PATH));

  await ensureSchema();

  // ── Users ────────────────────────────────────────────────────────────────
  const users = rowsOf(legacy, 'SELECT * FROM users');
  let usersCopied = 0;

  for (const u of users) {
    const exists = await one('SELECT id FROM users WHERE id = ? OR email = ?', [u.id, u.email]);
    if (exists) {
      console.log(`  = user ${u.username} (already present)`);
      continue;
    }
    if (!DRY_RUN) {
      await run(
        'INSERT INTO users (id, username, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)',
        [u.id, u.username, u.email, u.password_hash, u.created_at]
      );
    }
    usersCopied++;
    console.log(`  + user ${u.username}`);
  }

  // ── Files ────────────────────────────────────────────────────────────────
  const files = rowsOf(legacy, 'SELECT * FROM files');
  let filesCopied = 0;
  let filesMissing = 0;

  for (const f of files) {
    const exists = await one('SELECT id FROM files WHERE id = ?', [f.id]);
    if (exists) {
      console.log(`  = file ${f.original_name} (already present)`);
      continue;
    }

    const localPath = path.join(UPLOADS_DIR, f.stored_name);
    if (!fs.existsSync(localPath)) {
      console.warn(`  ! file ${f.original_name} — missing on disk (${f.stored_name}), skipped`);
      filesMissing++;
      continue;
    }

    if (DRY_RUN) {
      console.log(`  + file ${f.original_name} (${(f.size_bytes / 1024 / 1024).toFixed(2)} MB)`);
      filesCopied++;
      continue;
    }

    const blob = await put(f.original_name, fs.createReadStream(localPath), {
      access: 'public',
      addRandomSuffix: true,
      contentType: f.mime_type,
      token: process.env.BLOB_READ_WRITE_TOKEN
    });

    await run(
      `INSERT INTO files
         (id, original_name, stored_name, blob_url, mime_type, size_bytes, tags, user_id, download_count, uploaded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [f.id, f.original_name, blob.pathname, blob.url, f.mime_type, f.size_bytes,
        f.tags || '[]', f.user_id, f.download_count || 0, f.uploaded_at]
    );

    filesCopied++;
    console.log(`  + file ${f.original_name} → ${blob.pathname}`);
  }

  legacy.close();

  console.log(`\nDone. ${usersCopied} user(s), ${filesCopied} file(s) migrated.`);
  if (filesMissing) console.log(`${filesMissing} record(s) had no file on disk and were skipped.`);
}

main().catch(err => {
  console.error('\nMigration failed:', err.message);
  process.exit(1);
});
