# Universal Downloader ⬇

> Open file library — upload, share, and download files freely.

A self-hosted file sharing platform where authenticated users can upload and manage files, while anyone can browse and download from the community library. Built with Node.js and Express, backed by Turso (SQLite) and Vercel Blob. Total community storage capped at 500 MB.

The same codebase runs on **Vercel** and **Railway** at the same time, against one shared database and file store — upload on either URL and the file shows up on both.

---

## Features

- **Public Library** — Browse and download files without an account
- **Authenticated Uploads** — Register/login to upload and manage your files
- **Tag System** — Auto-categorized by file type + custom tags for easy filtering
- **Search & Filter** — Find files by name or filter by tag category
- **Storage Quota** — 500 MB total community storage with visual usage indicator
- **Drag & Drop** — Upload files with drag & drop and real-time progress tracking
- **Large uploads anywhere** — files go straight from the browser to blob storage, so Vercel's 4.5 MB function body limit never applies

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Node.js + Express |
| Database | Turso / libSQL (`@libsql/client`) |
| File storage | Vercel Blob (`@vercel/blob`) |
| Auth | JWT + bcryptjs |
| Uploads | Direct browser → Blob, server-issued tokens |
| Frontend | Vanilla HTML / CSS / JS |
| Hosting | Vercel and/or Railway |

## Quick Start

```bash
git clone https://github.com/BruisedKnuckless/universal-downloader.git
cd universal-downloader
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

For local development the database can be a plain file (no Turso account needed), but uploads
still require a real Blob token.

## Environment Variables

Create a `.env` file in the root:

```env
PORT=3000
JWT_SECRET=your-secret-key-here
ADMIN_SECRET=your-admin-secret
TOTAL_STORAGE_LIMIT_MB=500

# Database — a libsql://... URL in production, or file:./uploads/local.db locally
TURSO_DATABASE_URL=file:./uploads/local.db
TURSO_AUTH_TOKEN=

# File storage — from the Vercel dashboard → Storage → your Blob store
BLOB_READ_WRITE_TOKEN=vercel_blob_rw_...
```

`JWT_SECRET`, `TURSO_DATABASE_URL` and `BLOB_READ_WRITE_TOKEN` are required — the app refuses to
start without them and names the ones that are missing.

> ⚠️ **Change `JWT_SECRET`** to a strong random string in production.

## Setting up the backing services

1. **Turso** — create a database, then copy its URL and auth token.
   Tables are created automatically on first request.
2. **Vercel Blob** — create a Blob store in the Vercel dashboard and copy `BLOB_READ_WRITE_TOKEN`.
   This token works from any host, which is what lets Railway share the same store.

## Deploy to Vercel

1. Import the repo at [vercel.com](https://vercel.com) — no build command or framework preset needed.
2. Set `JWT_SECRET`, `ADMIN_SECRET`, `TOTAL_STORAGE_LIMIT_MB`, `TURSO_DATABASE_URL`,
   `TURSO_AUTH_TOKEN`, `BLOB_READ_WRITE_TOKEN`.
3. Deploy. `vercel.json` serves `public/` from the CDN and routes `/api/*` to the Express app in
   `api/index.js`.

## Deploy to Railway

1. **New Project** → **Deploy from GitHub repo**.
2. Set the same environment variables as above (`PORT` is provided by Railway).
3. Deploy. No persistent volume is needed any more — nothing is written to disk.

## Migrating from the old disk-based version

Earlier versions kept a SQLite file and uploads on a local volume. To move that data into the
shared backend, point the migration script at the old volume:

```bash
node scripts/migrate-to-cloud.js --uploads-dir /path/to/old/uploads --dry-run
node scripts/migrate-to-cloud.js --uploads-dir /path/to/old/uploads
```

It is idempotent, so a partial run can simply be repeated.

## Rebuilding the browser upload bundle

`public/js/vendor/blob-client.js` is a committed esbuild bundle of `@vercel/blob/client`, so no
host needs a build step. Regenerate it after upgrading the package:

```bash
npm run build:client
```

## API Endpoints

| Endpoint | Method | Auth | Description |
|---|---|---|---|
| `/api/auth/register` | POST | No | Create account |
| `/api/auth/login` | POST | No | Login, returns JWT |
| `/api/auth/me` | GET | Yes | Current user info |
| `/api/auth/account` | DELETE | Yes | Delete own account and files |
| `/api/files` | GET | No | List files (paginated, searchable) |
| `/api/files/upload-token` | POST | Yes | Issue a client upload token, capped at remaining quota |
| `/api/files/confirm` | POST | Yes | Record a finished upload |
| `/api/files/:id/download` | GET | No | Redirects to the file as an attachment |
| `/api/files/:id/preview` | GET | No | Redirects to the file inline |
| `/api/files/:id` | DELETE | Yes | Delete own file |
| `/api/files/storage-info` | GET | No | Storage usage stats |
| `/api/files/tags` | GET | No | All unique tags |
| `/api/admin/users` | GET | Admin | List users with file stats |
| `/api/admin/users/:id` | DELETE | Admin | Delete a user and their files |
| `/api/admin/cleanup` | POST | Admin | Remove orphaned blobs |

## License

MIT
