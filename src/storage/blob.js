const vercelBlob = require('@vercel/blob');

/**
 * File storage backed by Vercel Blob.
 *
 * The SDK talks to Blob over HTTPS using BLOB_READ_WRITE_TOKEN, which is
 * supported for code running outside Vercel too — that is what lets the Railway
 * deployment share the same file store.
 */

function token() {
  const t = process.env.BLOB_READ_WRITE_TOKEN;
  if (!t) throw new Error('BLOB_READ_WRITE_TOKEN is not set');
  return t;
}

/** Metadata for one blob (size, contentType, downloadUrl…), or null if gone. */
async function head(url) {
  try {
    return await vercelBlob.head(url, { token: token() });
  } catch (err) {
    if (err instanceof vercelBlob.BlobNotFoundError) return null;
    throw err;
  }
}

/** Delete one blob by URL. Missing blobs are treated as already deleted. */
async function remove(url) {
  try {
    await vercelBlob.del(url, { token: token() });
    return true;
  } catch (err) {
    if (err instanceof vercelBlob.BlobNotFoundError) return false;
    throw err;
  }
}

/** Delete many blobs in one call. */
async function removeMany(urls) {
  if (!urls.length) return;
  await vercelBlob.del(urls, { token: token() });
}

/** Every blob in the store, following pagination to the end. */
async function listAll() {
  const blobs = [];
  let cursor;

  do {
    const page = await vercelBlob.list({ token: token(), cursor, limit: 1000 });
    blobs.push(...page.blobs);
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);

  return blobs;
}

/**
 * True when a failure means "storage is misconfigured" rather than
 * "that file is missing" — a bad or absent token, or a store that is gone.
 * Worth separating so first-time setup gets a message that names the cause.
 */
function isConfigError(err) {
  return err instanceof vercelBlob.BlobStoreNotFoundError
    || err instanceof vercelBlob.BlobAccessError
    || err instanceof vercelBlob.BlobStoreSuspendedError
    || /BLOB_READ_WRITE_TOKEN is not set/.test(err && err.message);
}

const CONFIG_ERROR_MESSAGE =
  'File storage is unavailable — check that BLOB_READ_WRITE_TOKEN is set and the Blob store exists.';

module.exports = { head, remove, removeMany, listAll, isConfigError, CONFIG_ERROR_MESSAGE };
