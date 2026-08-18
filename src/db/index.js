/**
 * Two client builds ship in this package. The default one pulls in a native
 * binary so it can open `file:` databases; the `/web` one is pure fetch.
 * Production always talks to a remote libsql:// URL, so it takes the web
 * build — no native module inside the serverless function, and a smaller
 * deployment. Local `file:` development gets the native build.
 */
function loadCreateClient(url) {
  const isRemote = /^(libsql|wss?|https?):/.test(url);
  return isRemote
    ? require('@libsql/client/web').createClient
    : require('@libsql/client').createClient;
}

/**
 * Data layer backed by Turso (libSQL).
 *
 * Unlike the old sql.js setup there is no in-memory copy and no saveDB() —
 * every write goes straight to the database, so Vercel's read-only filesystem
 * and Railway's volume are both irrelevant, and the two hosts can share one
 * dataset.
 *
 * A `file:` URL is also accepted, which is what local development uses.
 */

let client = null;

function getClient() {
  if (client) return client;

  const url = process.env.TURSO_DATABASE_URL;
  if (!url) throw new Error('TURSO_DATABASE_URL is not set');

  const createClient = loadCreateClient(url);
  client = createClient({
    url,
    // Local file: databases need no token.
    authToken: process.env.TURSO_AUTH_TOKEN || undefined
  });
  return client;
}

/**
 * Creates the tables once per process.
 *
 * Serverless functions have no reliable startup hook, so instead of an async
 * bootstrap the promise is memoized here and awaited by every query helper.
 */
let schemaPromise = null;

function ensureSchema() {
  if (schemaPromise) return schemaPromise;

  schemaPromise = (async () => {
    const db = getClient();

    await db.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS files (
        id TEXT PRIMARY KEY,
        original_name TEXT NOT NULL,
        stored_name TEXT NOT NULL UNIQUE,
        blob_url TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        tags TEXT DEFAULT '[]',
        user_id TEXT NOT NULL,
        download_count INTEGER DEFAULT 0,
        uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    await db.execute('CREATE INDEX IF NOT EXISTS idx_files_user_id ON files(user_id)');
    await db.execute('CREATE INDEX IF NOT EXISTS idx_files_uploaded_at ON files(uploaded_at)');
  })();

  // Don't cache a failed bootstrap — let the next request retry.
  schemaPromise.catch(() => { schemaPromise = null; });

  return schemaPromise;
}

/** Run a statement, returning the raw result set. */
async function run(sql, args = []) {
  await ensureSchema();
  return getClient().execute({ sql, args });
}

/** Run a SELECT that returns every matching row. */
async function all(sql, args = []) {
  const result = await run(sql, args);
  return result.rows;
}

/** Run a SELECT that returns the first row, or null. */
async function one(sql, args = []) {
  const rows = await all(sql, args);
  return rows.length ? rows[0] : null;
}

module.exports = { getClient, ensureSchema, run, all, one };
