# CLAUDE.md — Viraj's Vault (Universal Downloader) Project Guide

> **This document is the single source of truth for any AI assistant working on this project.**
> Read it completely before making any changes.

---

## 1. Project Overview

**Viraj's Vault** (internally "Universal Downloader") is a self-hosted, open file-sharing web application. Users can register, upload files, tag them, and share them publicly. Anyone can browse and download files without an account.

- **Live URL**: `viraj-vault.up.railway.app`
- **Hosting**: Railway (free tier — 500 MB storage, $5/month credit)
- **Repository**: GitHub → deployed to Railway via auto-deploy on push

---

## 2. Tech Stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| **Runtime** | Node.js 20 (Alpine Docker) | `node:20-alpine` in Dockerfile |
| **Framework** | Express.js 4.x | Serves both API and static frontend |
| **Database** | SQLite via `sql.js` (WASM) | **NOT** `better-sqlite3` — see critical notes below |
| **Auth** | JWT (jsonwebtoken) + bcryptjs | 7-day token expiry |
| **File uploads** | Multer | Files stored in `/uploads/` directory |
| **Frontend** | Vanilla HTML/CSS/JS | No frameworks — single `app.js` file |
| **Fonts** | Custom: BebasNeue, Nohemi, NetflixSans | Loaded via `@font-face` from `/fonts/` |

---

## 3. Critical Architecture Notes

### 3.1 sql.js is IN-MEMORY (⚠️ MOST IMPORTANT)

`sql.js` is a WASM port of SQLite that loads the **entire database file into JavaScript memory** at startup. This has critical implications:

```
App starts → reads /uploads/data.db into RAM → all queries hit RAM copy
                                                 (disk file is stale until saveDB() is called)
```

- **All reads and writes happen in memory**, not on disk.
- **`saveDB()`** must be called after every write operation to persist changes to `/uploads/data.db`.
- **External CLI edits** (e.g., `sqlite3 /app/uploads/data.db`) modify the disk file but the running app doesn't know — it keeps using its stale in-memory copy.
- **If the app calls `saveDB()` after a CLI edit**, it **overwrites** the disk file with its in-memory state, reverting the CLI changes.
- **Restarting the app** forces it to reload from the (updated) disk file.

**Why not `better-sqlite3`?** It requires C++ compilation and failed on Railway's container (Node 26.4.0). `sql.js` is pure WASM and works everywhere.

**Rule: NEVER suggest using `better-sqlite3` or switching databases without testing on Railway first.**

### 3.2 File Storage

- **Physical files** are stored in `/uploads/` (mapped to `/app/uploads/` in Docker).
- **Database file** (`data.db`) also lives in `/uploads/` for persistence across redeployments.
- On Railway, `/app/uploads/` is a **persistent volume** — it survives redeployments.
- **Max file size**: no fixed per-file cap. Multer is sized per request to the storage remaining (`uploadWithLimit()` in `middleware/upload.js`), so a single file may be as large as the free space under the total quota.
- **Total storage limit**: 500 MB (Railway free plan limit, configurable via `TOTAL_STORAGE_LIMIT_MB`).

### 3.3 Orphaned Files Problem

When a user is deleted, their database records can be cascade-deleted, but the physical files on disk may survive if:
1. The delete was done via SQLite CLI (no filesystem cleanup)
2. The app crashed between DB delete and file cleanup

The admin panel has a **"Cleanup orphaned files"** button that scans `/uploads/` and removes any physical files not tracked in the `files` table.

---

## 4. Directory Structure

```
Universal Downloader/
├── .env                          # Environment variables (DO NOT commit to public repos)
├── .gitignore                    # Ignores node_modules, uploads/, data.db
├── Dockerfile                    # node:20-alpine + sqlite3 CLI
├── Procfile                      # Railway/Heroku: "web: node src/server.js"
├── package.json                  # Dependencies and scripts
│
├── src/                          # Backend source
│   ├── server.js                 # Express app bootstrap, route registration
│   ├── db/
│   │   └── init.js               # sql.js database init, saveDB(), getDB()
│   ├── middleware/
│   │   ├── auth.js               # JWT auth middleware (authRequired, authOptional)
│   │   └── upload.js             # Multer config, UPLOADS_DIR export
│   └── routes/
│       ├── auth.js               # POST /register, POST /login, GET /me, DELETE /account
│       ├── files.js              # CRUD for files, storage-info, tags, download, preview
│       └── admin.js              # Admin-only routes (list users, delete user, cleanup)
│
├── public/                       # Static frontend (served by Express)
│   ├── index.html                # Library page (public file browser)
│   ├── auth.html                 # Login/Register page
│   ├── dashboard.html            # Authenticated user's upload/manage page
│   ├── css/
│   │   └── styles.css            # ALL styling — single file, CSS custom properties
│   ├── js/
│   │   └── app.js                # ALL frontend logic — single file, vanilla JS
│   └── fonts/
│       ├── BebasNeue.otf         # Main heading font
│       ├── Nohemi-VF-BF6438cc58ad63d.ttf  # Secondary heading font
│       ├── NetflixSans-Bd.ttf    # Body text font
│       ├── white-paper-texture.jpg    # Navbar background texture
│       └── white-paper-texture2.jpg   # Page background texture
│
├── uploads/                      # File storage (gitignored, persistent volume on Railway)
│   └── data.db                   # SQLite database file
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
    stored_name TEXT NOT NULL,         -- UUID-based filename on disk
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
| DELETE | `/account` | JWT | Delete own account + all files (DB + disk) |

### Files (`/api/files/`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/` | No | List files. Query params: `page`, `limit`, `tag`, `search` |
| POST | `/upload` | JWT | Upload file. Multipart: `file` + `tags` (comma-separated) |
| GET | `/storage-info` | No | Get `{ totalLimit, totalUsed, remaining }` |
| GET | `/tags` | No | Get all unique tags across files |
| GET | `/download/:id` | No | Download a file (increments download_count) |
| GET | `/preview/:id` | No | Inline preview (Content-Disposition: inline) |
| DELETE | `/:id` | JWT | Delete own file (DB + disk) |

### Admin (`/api/admin/`)

All admin routes require the `x-admin-secret` header matching `ADMIN_SECRET` env var.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/users` | List all users with file count and storage used |
| DELETE | `/users/:id` | Delete a user + their files (DB + disk + saveDB) |
| POST | `/cleanup` | Remove orphaned physical files not tracked in DB |

---

## 7. Environment Variables

```env
PORT=3000
JWT_SECRET=ud-secret-change-in-production-a7f3b2e9d1c4
TOTAL_STORAGE_LIMIT_MB=500
NODE_ENV=development
ADMIN_SECRET=11-05-06
```

**On Railway, set these in the Variables tab. The `.env` file is for local dev only.**

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
- **Delete any user** (removes DB records + physical files + calls `saveDB()` — all in one shot)
- **Cleanup orphaned files** (removes physical files on disk that have no DB record)

### Implementation
- **Frontend**: Inline-styled modal injected into the DOM (no CSS changes needed)
- **Backend**: `/api/admin/*` routes protected by `x-admin-secret` header
- The trap door `<span>` has `id="trap-door"` on line 33 of `index.html`

---

## 11. Known Issues & Gotchas

### ⚠️ sql.js In-Memory Sync
- **NEVER edit the database via `sqlite3` CLI** while the app is running. Changes will be lost or overwritten.
- Always use the admin panel or API endpoints to modify data.
- If you must use CLI: edit → immediately restart the app before any `saveDB()` call occurs.

### ⚠️ better-sqlite3 Doesn't Work on Railway
- Requires native C++ compilation that fails on Railway's build environment.
- Don't switch to it unless you've confirmed it compiles in the Docker container.

### ⚠️ Xbox Edge Browser
- File downloads don't work on Xbox Series X Edge browser ("Downloads are not supported on this device").
- Workaround: The "Preview" button opens files inline (`Content-Disposition: inline`) so users can right-click → "Set as desktop wallpaper" on images.

### ⚠️ Storage Bar After Manual Deletes
- The storage bar reads from `SUM(size_bytes) FROM files` in the in-memory DB.
- If files are deleted via CLI without removing physical files, storage appears freed in DB but disk space is still consumed.
- Use the admin panel's "Cleanup orphaned files" to reconcile.

---

## 12. Running Locally

```bash
cd "Universal Downloader"
npm install
npm run dev        # Starts with --watch for auto-restart on changes
# → http://localhost:3000
```

---

## 13. Deploying to Railway

1. Push changes to GitHub: `git add -A && git commit -m "message" && git push`
2. Railway auto-deploys from the connected GitHub repo
3. Ensure these **environment variables** are set in Railway's Variables tab:
   - `JWT_SECRET` (change from default!)
   - `TOTAL_STORAGE_LIMIT_MB=500`
   - `ADMIN_SECRET=11-05-06`
4. Ensure `/app/uploads/` is configured as a **persistent volume** in Railway

---

## 14. Railway Console Quick Reference

### Open SQLite CLI
```bash
sqlite3 /app/uploads/data.db
```

### List all users
```sql
SELECT id, username, email, created_at FROM users;
```

### Delete orphan file records (no matching user)
```sql
PRAGMA foreign_keys = ON;
DELETE FROM files WHERE user_id NOT IN (SELECT id FROM users);
```

### Delete orphan physical files from disk
```bash
sqlite3 /app/uploads/data.db "SELECT stored_name FROM files;" > /tmp/db_files.txt
cd /app/uploads && for f in *; do [ "$f" = "data.db" ] && continue; grep -qF "$f" /tmp/db_files.txt || (echo "Removing: $f" && rm "$f"); done
```

### After any CLI edits: **RESTART** the Railway deployment immediately.

---

## 15. File-by-File Reference

### Backend

| File | Purpose | Key Exports |
|------|---------|-------------|
| `src/server.js` | Express app setup, route registration, error handler | — |
| `src/db/init.js` | sql.js database initialization, table creation | `initDB()`, `getDB()`, `saveDB()` |
| `src/middleware/auth.js` | JWT verification middleware | `authRequired`, `authOptional` |
| `src/middleware/upload.js` | Multer config with UUID filenames | `upload`, `UPLOADS_DIR` |
| `src/routes/auth.js` | Registration, login, profile, account deletion | Express router |
| `src/routes/files.js` | File CRUD, storage info, tags, download, preview | Express router |
| `src/routes/admin.js` | Admin user management and cleanup | Express router |

### Frontend

| File | Purpose |
|------|---------|
| `public/index.html` | Library page — public file browser |
| `public/auth.html` | Login/Register page |
| `public/dashboard.html` | Authenticated user's dashboard |
| `public/css/styles.css` | ALL styles — single file with CSS variables |
| `public/js/app.js` | ALL frontend logic — API calls, DOM manipulation, admin panel |

---

## 16. Rules for Making Changes

1. **CSS changes** → Only modify `public/css/styles.css`. All design tokens are in `:root`.
2. **Never remove comments** or docstrings that are unrelated to your changes.
3. **Always call `saveDB()`** after any database write operation.
4. **Test on mobile** — the user cares deeply about mobile responsiveness (two breakpoints: 768px and 480px).
5. **No glow effects** — the user explicitly removed all blur/glow CSS effects. Don't add them back.
6. **Font usage** — BebasNeue for big headings, Nohemi for subheadings, NetflixSans for body text. Don't use system fonts.
7. **Color palette** — White background with paper texture, red accent, black text. No purple, blue, or green. Yellow/gold is secondary accent only.
8. **The "VIRAJ'S VAULT" title** — each letter is a separate `<span>`. The 4th span (the "A" in VIRAJ) has `id="trap-door"` and is the admin panel trigger. Don't change this.
9. **Admin panel styles are inline** — they're injected via JavaScript, not in `styles.css`. Keep it self-contained.
10. **Preview button** — exists for Xbox Edge compatibility. Opens files inline in a new tab. Don't remove it.
