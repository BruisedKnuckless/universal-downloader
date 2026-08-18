# CLAUDE.md — Viraj's Vault (Universal Downloader) Project Guide

> **This document is the single source of truth for any AI assistant working on this project.**
> Read it completely before making any changes.

---

## 1. Project Overview

**Viraj's Vault** (internally "Universal Downloader") is a self-hosted, open file-sharing web application. Users can register, upload files, tag them, and share them publicly. Anyone can browse and download files without an account.

- **Live URL**: `viraj-vault.up.railway.app`
- **Hosting**: Railway **and** Vercel, running the same code against one shared backend
- **Repository**: GitHub → auto-deploy on push (`main` → Railway, `vercel` → Vercel)

### Branches
| Branch | Deploys to | Notes |
|---|---|---|
| `main` | Railway | Historically the disk-based version |
| `vercel` | Vercel (and Railway) | Cloud backend — Turso + Vercel Blob |

---

## 2. Tech Stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| **Runtime** | Node.js 20 | Docker on Railway, serverless function on Vercel |
| **Framework** | Express.js 4.x | Serves both API and static frontend |
| **Database** | Turso / libSQL (`@libsql/client`) | SQLite over HTTPS — reachable from both hosts |
| **File storage** | Vercel Blob (`@vercel/blob`) | Works off-Vercel too via `BLOB_READ_WRITE_TOKEN` |
| **Auth** | JWT (jsonwebtoken) + bcryptjs | 7-day token expiry |
| **File uploads** | Direct browser → Blob | No Multer; server only issues capped tokens |
| **Frontend** | Vanilla HTML/CSS/JS | No frameworks — single `app.js` file |
| **Fonts** | Custom: BebasNeue, Nohemi, NetflixSans | Loaded via `@font-face` from `/fonts/` |

---

## 3. Critical Architecture Notes

### 3.1 Nothing is stored on disk (⚠️ MOST IMPORTANT)

The app writes **no** application data to the filesystem. This is what lets it run on Vercel, where
functions get a read-only filesystem (apart from an ephemeral `/tmp`) and no persistent volume.

```
Browser ──upload──────────────────────────────► Vercel Blob
   │                                                 ▲
   └──1. ask for token──► Express ──2. record──► Turso DB
                          (Vercel or Railway)
```

- **Database** is Turso (libSQL) over HTTPS. Every write lands immediately — there is no in-memory
  copy and **no `saveDB()`**. The old stale-copy footgun is gone.
- **Files** live in Vercel Blob, addressed by the `blob_url` column.
- **Both hosts share one backend**, so a file uploaded on Vercel appears on Railway and vice versa.
- Schema is created lazily by a memoized `ensureSchema()` in `src/db/index.js`, because serverless
  functions have no reliable startup hook.

**Rule: never reintroduce disk persistence** (`fs.writeFileSync` for data, multer disk storage,
SQLite files). It would work on Railway and silently break Vercel.

### 3.2 File Storage

- **Uploads go straight from the browser to Blob.** The server never receives the bytes; it only
  issues a short-lived token (`POST /api/files/upload-token`).
- **Why:** Vercel functions reject request bodies over **4.5 MB**. Routing uploads through the
  server would cap files at 4.5 MB there.
- **Downloads and previews are 302 redirects** to the blob URL. The same 4.5 MB cap applies to
  *responses*, so a large file cannot be streamed through the function at all.
- **Max file size**: no fixed per-file cap. The upload token is capped at
  `maximumSizeInBytes = remaining quota`, so Blob itself refuses anything larger.
- **Total storage limit**: 500 MB, configurable via `TOTAL_STORAGE_LIMIT_MB`.

### 3.3 Orphaned Files Problem

A blob can outlive its database row if the browser uploads successfully but never reaches
`POST /api/files/confirm` (tab closed, connection dropped).

The admin panel's **"Cleanup orphaned files"** button lists the blob store and deletes anything
whose `pathname` has no matching `stored_name` in the `files` table.

---

## 4. Directory Structure

```
Universal Downloader/
├── .env                          # Environment variables (DO NOT commit to public repos)
├── .gitignore                    # Ignores node_modules, uploads/, data.db
├── .vercelignore                 # Keeps the Docker/Railway bits out of the Vercel bundle
├── vercel.json                   # Static public/, rewrites /api/* to the Express function
├── Dockerfile                    # node:20-alpine (Railway)
├── Procfile                      # Railway/Heroku: "web: node src/server.js"
├── package.json                  # Dependencies and scripts
│
├── api/
│   └── index.js                  # Vercel entry point — exports the Express app
│
├── scripts/
│   ├── build-client.js           # esbuild → public/js/vendor/blob-client.js
│   └── migrate-to-cloud.js       # One-time: old data.db + uploads/ → Turso + Blob
│
├── src/                          # Backend source
│   ├── app.js                    # Builds the Express app (no listen) + env validation
│   ├── server.js                 # listen() wrapper for local/Railway
│   ├── db/
│   │   └── index.js              # Turso client, ensureSchema(), one()/all()/run()
│   ├── storage/
│   │   └── blob.js               # Vercel Blob wrappers: head, remove, removeMany, listAll
│   ├── middleware/
│   │   └── auth.js               # JWT auth middleware (authRequired, authOptional)
│   └── routes/
│       ├── auth.js               # POST /register, POST /login, GET /me, DELETE /account
│       ├── files.js              # List, upload-token, confirm, download, preview, delete
│       └── admin.js              # Admin-only routes (list users, delete user, cleanup)
│
├── public/                       # Static frontend (Express locally, Vercel CDN in prod)
│   ├── index.html                # Library page (public file browser)
│   ├── auth.html                 # Login/Register page
│   ├── dashboard.html            # Authenticated user's upload/manage page
│   ├── css/
│   │   └── styles.css            # ALL styling — single file, CSS custom properties
│   ├── js/
│   │   ├── app.js                # ALL frontend logic — single file, vanilla JS
│   │   └── vendor/
│   │       └── blob-client.js    # Committed esbuild bundle of @vercel/blob/client
│   └── fonts/
│       ├── BebasNeue.otf         # Main heading font
│       ├── Nohemi-VF-BF6438cc58ad63d.ttf  # Secondary heading font
│       ├── NetflixSans-Bd.ttf    # Body text font
│       ├── white-paper-texture.jpg    # Navbar background texture
│       └── white-paper-texture2.jpg   # Page background texture
│
├── uploads/                      # Local dev only (gitignored) — holds local.db
│
└── fonts/                        # Source font files (NOT served — copies are in public/fonts/)
```

---

## 5. Database Schema

```sql
-- Users table
CREATE TABLE users (
    id TEXT PRIMARY KEY,              -- UUID v4
    username TEXT UNIQUE NOT NULL,     -- 3-30 chars, alphanumeric + underscore
    email TEXT UNIQUE NOT NULL,        -- Stored lowercase
    password_hash TEXT NOT NULL,       -- bcrypt, 12 salt rounds
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Files table
CREATE TABLE files (
    id TEXT PRIMARY KEY,              -- UUID v4
    original_name TEXT NOT NULL,       -- User's original filename
    stored_name TEXT NOT NULL UNIQUE,  -- Blob pathname (UNIQUE: stops one blob being claimed twice)
    blob_url TEXT NOT NULL,            -- Public Vercel Blob URL
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    tags TEXT DEFAULT '[]',            -- JSON array of tag strings
    user_id TEXT NOT NULL,
    download_count INTEGER DEFAULT 0,
    uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Indexes
CREATE INDEX idx_files_user_id ON files(user_id);
CREATE INDEX idx_files_uploaded_at ON files(uploaded_at);
```

---

## 6. API Endpoints

### Auth (`/api/auth/`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/register` | No | Create account. Body: `{ username, email, password }` |
| POST | `/login` | No | Login. Body: `{ email, password }`. Returns JWT |
| GET | `/me` | JWT | Get current user info |
| DELETE | `/account` | JWT | Delete own account + all files (DB + blobs) |

### Files (`/api/files/`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/` | No | List files. Query params: `page`, `limit`, `tag`, `search` |
| POST | `/upload-token` | JWT | Issue a Blob client token capped at the remaining quota |
| POST | `/confirm` | JWT | Record a finished upload. Body: `{ url, originalName, tags }` |
| GET | `/storage-info` | No | Get `{ totalLimit, totalUsed, remaining }` |
| GET | `/tags` | No | Get all unique tags across files |
| GET | `/:id/download` | No | 302 → blob `?download=1` (increments download_count) |
| GET | `/:id/preview` | No | 302 → blob URL, served inline |
| DELETE | `/:id` | JWT | Delete own file (DB + blob) |

> **Note the path shape:** `/:id/download`, not `/download/:id`.

**Uploads are a two-step flow** — the browser asks for a token, uploads straight to Blob, then
calls `/confirm`. Nothing but metadata passes through the server.

### Admin (`/api/admin/`)

All admin routes require the `x-admin-secret` header matching `ADMIN_SECRET` env var.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/users` | List all users with file count and storage used |
| DELETE | `/users/:id` | Delete a user + their files (DB + blobs) |
| POST | `/cleanup` | Remove orphaned blobs not tracked in DB |

---

## 7. Environment Variables

```env
PORT=3000
JWT_SECRET=ud-secret-change-in-production-a7f3b2e9d1c4
TOTAL_STORAGE_LIMIT_MB=500
NODE_ENV=development
ADMIN_SECRET=11-05-06

# Database — libsql://... in production, file:./uploads/local.db for local dev
TURSO_DATABASE_URL=file:./uploads/local.db
TURSO_AUTH_TOKEN=

# File storage — works from Vercel AND Railway
BLOB_READ_WRITE_TOKEN=vercel_blob_rw_...
```

`JWT_SECRET`, `TURSO_DATABASE_URL` and `BLOB_READ_WRITE_TOKEN` are **required**: `src/app.js`
throws at boot naming any that are missing, rather than failing later with confusing 500s.

**Set these in both the Vercel and Railway dashboards. The `.env` file is for local dev only.**

---

## 8. Frontend Architecture

### Pages
- **`index.html`** (`data-page="library"`) — Public file browser with search, tag filters, storage bar, pagination
- **`auth.html`** (`data-page="auth"`) — Login/Register with tab switcher
- **`dashboard.html`** (`data-page="dashboard"`) — Authenticated user's file upload and management

### Single JS File (`app.js`)
All frontend logic lives in one file. Key sections:
- **`API` object** — Fetch wrapper with JWT header injection
- **`Toast`** — Notification system
- **`initLibrary()`** — Public page: file grid, search, tag filtering, pagination
- **`initAuth()`** — Auth page: login/register forms
- **`initDashboard()`** — Dashboard: upload zone, file management
- **Admin panel** — Secret trap door (see below)

### Auth Token Storage
- Token stored in `localStorage` as `ud_token`
- User data stored as `ud_user` (JSON string)
- Navigation dynamically shows Login/Register or Dashboard/Logout based on token presence

---

## 9. Design System & Theming

### Current Theme: Light with Paper Texture

The entire design is controlled by CSS custom properties in `:root`. **Key design decisions:**

| Element | Value | Notes |
|---------|-------|-------|
| **Background** | White + `white-paper-texture2.jpg` | `repeat-y`, scrolls with page |
| **Navbar** | Solid white `rgb(255, 255, 255)` | Heavy shadow: `0 4px 20px rgba(0,0,0,0.3)` |
| **Text** | Black `#111111` / `#444444` / `#555555` | Triple-layer text-shadow for readability on texture |
| **Accent** | Red `#e60000` / `#ff1a1a` | Used for buttons, active states, highlights |
| **Secondary accent** | Yellow/Gold `#cc9900` | Used in gradients and warnings |
| **Cards** | White `#ffffff` with light borders | Subtle shadows |
| **Glow effects** | **REMOVED** | User explicitly requested no glowing effects |

### Typography
| Font | Usage | File |
|------|-------|------|
| **BebasNeue** | Main headings (`--font-heading`) | `BebasNeue.otf` |
| **Nohemi** | Secondary headings (`--font-subheading`) | `Nohemi-VF-BF6438cc58ad63d.ttf` |
| **NetflixSans** | Body text (`--font-body`) | `NetflixSans-Bd.ttf` |

### "VIRAJ'S VAULT" Title
- Each letter is a separate `<span>` for hover animation effects
- Font size: `clamp(2.5rem, 13vw, 100px)` — dynamically scales, never wraps
- Color: `red` with `text-shadow: 3px 2px 2px black`
- Hover: `scale(1.3)` on individual letters
- Active/Click: `scale(0.8)` press effect

### Mobile Responsiveness
Two breakpoints:
- `@media (max-width: 768px)` — Tablet adjustments
- `@media (max-width: 480px)` — Phone: stacked layouts, smaller fonts, brand text hidden, full-width buttons

---

## 10. Secret Admin Panel (Trap Door)

### How to Access
1. Go to the homepage (`index.html`)
2. Click the **"A"** letter in **"VIR`A`J'S VAULT"** **5 times** within 2 seconds
3. A browser prompt asks for the admin secret → enter: `11-05-06`
4. The admin panel overlay opens

### What It Can Do
- **View all users** with file counts, storage used, and join dates
- **Delete any user** (removes DB records + their blobs — all in one shot)
- **Cleanup orphaned files** (removes blobs that have no DB record)

### Implementation
- **Frontend**: Inline-styled modal injected into the DOM (no CSS changes needed)
- **Backend**: `/api/admin/*` routes protected by `x-admin-secret` header
- The trap door `<span>` has `id="trap-door"` on line 33 of `index.html`

---

## 11. Known Issues & Gotchas

### ⚠️ Vercel's 4.5 MB body limit shapes the whole upload design
- It applies to **requests and responses**, at infrastructure level — `vercel.json` cannot raise it.
- That is why uploads go browser → Blob directly, and why downloads/previews are **redirects**
  rather than streamed through the server. Don't "simplify" either back into a proxy.

### ⚠️ Never write application data to disk
- Vercel functions have a read-only filesystem (bar an ephemeral `/tmp`). Anything written there
  disappears and is invisible to other instances.
- This works fine on Railway, so a disk-based change can pass local testing and still break Vercel.

### ⚠️ Both hosts share one database and blob store
- A destructive admin action (delete user, cleanup) affects **both** deployments at once.

### ⚠️ `onUploadCompleted` is deliberately unused
- Vercel Blob cannot reach `localhost`, and off-Vercel it needs an explicit `callbackUrl`.
- `POST /api/files/confirm` is the real path and works in every environment. The empty
  `onUploadCompleted` exists only so Blob gets a 200 and stops retrying.

### ⚠️ The upload SDK hides server error messages
- On a non-2xx from `/upload-token`, `upload()` throws a generic "Failed to retrieve the client
  token" and discards our JSON body. `explainUploadFailure()` in `app.js` re-queries storage-info
  to reconstruct a useful message — keep it if you touch that path.

### ⚠️ Xbox Edge Browser
- File downloads don't work on Xbox Series X Edge browser ("Downloads are not supported on this device").
- Workaround: The "Preview" button opens files inline so users can right-click → "Set as desktop wallpaper" on images. Blob serves the plain URL inline and the `?download=1` variant as an attachment, which is exactly how the two buttons differ.

### ⚠️ Rebuild the client bundle after upgrading @vercel/blob
- `public/js/vendor/blob-client.js` is committed, not built at deploy time. Run `npm run build:client`.

---

## 12. Running Locally

```bash
cd "Universal Downloader"
npm install
npm run build:client   # only needed after upgrading @vercel/blob
npm run dev            # --watch for auto-restart
# → http://localhost:3000
```

The database can be a local file (`TURSO_DATABASE_URL=file:./uploads/local.db`) with no Turso
account. Uploads still need a real `BLOB_READ_WRITE_TOKEN` — there is no local Blob emulator.

---

## 13. Deploying

Both hosts run the same code against the same Turso database and Blob store.

### Vercel
1. Import the repo — **no** build command or framework preset.
2. Set `JWT_SECRET`, `ADMIN_SECRET`, `TOTAL_STORAGE_LIMIT_MB`, `TURSO_DATABASE_URL`,
   `TURSO_AUTH_TOKEN`, `BLOB_READ_WRITE_TOKEN`.
3. `vercel.json` serves `public/` from the CDN and rewrites `/api/*` to `api/index.js`.

### Railway
1. Push to GitHub; Railway auto-deploys.
2. Set the same variables (`PORT` is injected automatically).
3. **No persistent volume needed any more** — nothing is written to disk.

> ⚠️ Deploying this code without `TURSO_DATABASE_URL` / `BLOB_READ_WRITE_TOKEN` fails at boot
> with a message naming the missing variables. Set them *before* redeploying.

---

## 14. Operations Quick Reference

### Inspect the database
```bash
turso db shell <database-name>
SELECT id, username, email, created_at FROM users;
```

### Delete orphan file records (no matching user)
```sql
DELETE FROM files WHERE user_id NOT IN (SELECT id FROM users);
```

### Delete orphan blobs
Use the admin panel's **Cleanup orphaned files** button — it reconciles the blob store against the
`files` table. There is no filesystem to sweep by hand.

> Unlike the old sql.js setup, editing the database directly is safe: there is no in-memory copy to
> go stale, and no restart is required afterwards.

### Migrate old disk-based data
```bash
node scripts/migrate-to-cloud.js --uploads-dir /path/to/old/uploads --dry-run
node scripts/migrate-to-cloud.js --uploads-dir /path/to/old/uploads
```

---

## 15. File-by-File Reference

### Backend

| File | Purpose | Key Exports |
|------|---------|-------------|
| `src/app.js` | Builds the Express app, validates env, registers routes | the app |
| `src/server.js` | `listen()` wrapper for local/Railway | — |
| `api/index.js` | Vercel function entry — re-exports the app | the app |
| `src/db/index.js` | Turso client, lazy schema, query helpers | `one`, `all`, `run`, `ensureSchema`, `getClient` |
| `src/storage/blob.js` | Vercel Blob wrappers | `head`, `remove`, `removeMany`, `listAll`, `isConfigError` |
| `src/middleware/auth.js` | JWT verification middleware | `authRequired`, `authOptional` |
| `src/routes/auth.js` | Registration, login, profile, account deletion | Express router |
| `src/routes/files.js` | Listing, upload tokens, confirm, download, preview, delete | Express router |
| `src/routes/admin.js` | Admin user management and cleanup | Express router |
| `scripts/build-client.js` | Bundles `@vercel/blob/client` for the browser | — |
| `scripts/migrate-to-cloud.js` | One-time disk → Turso + Blob migration | — |

### Frontend

| File | Purpose |
|------|---------|
| `public/index.html` | Library page — public file browser |
| `public/auth.html` | Login/Register page |
| `public/dashboard.html` | Authenticated user's dashboard |
| `public/css/styles.css` | ALL styles — single file with CSS variables |
| `public/js/app.js` | ALL frontend logic — API calls, DOM manipulation, admin panel |
| `public/js/vendor/blob-client.js` | **Generated** — do not edit; run `npm run build:client` |

---

## 16. Rules for Making Changes

1. **CSS changes** → Only modify `public/css/styles.css`. All design tokens are in `:root`.
2. **Never remove comments** or docstrings that are unrelated to your changes.
3. **Never write application data to disk** — no SQLite files, no multer disk storage, no
   `fs.writeFileSync` for user data. It breaks Vercel while still passing on Railway.
   (There is no `saveDB()` any more; Turso writes are durable immediately.)
4. **Test on mobile** — the user cares deeply about mobile responsiveness (two breakpoints: 768px and 480px).
5. **No glow effects** — the user explicitly removed all blur/glow CSS effects. Don't add them back.
6. **Font usage** — BebasNeue for big headings, Nohemi for subheadings, NetflixSans for body text. Don't use system fonts.
7. **Color palette** — White background with paper texture, red accent, black text. No purple, blue, or green. Yellow/gold is secondary accent only.
8. **The "VIRAJ'S VAULT" title** — each letter is a separate `<span>`. The 4th span (the "A" in VIRAJ) has `id="trap-door"` and is the admin panel trigger. Don't change this.
9. **Admin panel styles are inline** — they're injected via JavaScript, not in `styles.css`. Keep it self-contained.
10. **Preview button** — exists for Xbox Edge compatibility. Opens files inline in a new tab. Don't remove it.
11. **Keep downloads and previews as redirects** — never proxy file bytes through the server, or
    anything over 4.5 MB breaks on Vercel.
12. **Both deployments share one backend** — a destructive change hits Vercel and Railway at once.
