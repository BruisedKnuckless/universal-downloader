# Universal Downloader ⬇

> Open file library — upload, share, and download files freely.

A self-hosted file sharing platform where authenticated users can upload and manage files, while anyone can browse and download from the community library. Built with Node.js, Express, and SQLite. Total community storage capped at 500 MB (Railway free plan).

---

## Features

- **Public Library** — Browse and download files without an account
- **Authenticated Uploads** — Register/login to upload and manage your files
- **Tag System** — Auto-categorized by file type + custom tags for easy filtering
- **Search & Filter** — Find files by name or filter by tag category
- **Storage Quota** — 500 MB total community storage with visual usage indicator
- **Drag & Drop** — Upload files with drag & drop and real-time progress tracking
- **Premium Dark UI** — Glassmorphic design with animations and responsive layout

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Node.js + Express |
| Database | SQLite (via better-sqlite3) |
| Auth | JWT + bcryptjs |
| File Upload | Multer |
| Frontend | Vanilla HTML / CSS / JS |
| Deployment | Docker / Railway / Render |

## Quick Start

```bash
# Clone
git clone https://github.com/BruisedKnuckless/universal-downloader.git
cd universal-downloader

# Install dependencies
npm install

# Start development server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## Environment Variables

Create a `.env` file in the root:

```env
PORT=3000
JWT_SECRET=your-secret-key-here
MAX_FILE_SIZE_MB=100
TOTAL_STORAGE_LIMIT_MB=500
```

> ⚠️ **Change `JWT_SECRET`** to a strong random string in production.

## Deploy to Railway

1. Push your repo to GitHub
2. Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**
3. Set environment variables:
   - `JWT_SECRET` — a strong random string
   - `PORT` — Railway sets this automatically
4. Add a **persistent volume** mounted at `/app/uploads` (required to persist uploaded files across deploys)
5. Deploy!

## Deploy to Render

1. Go to [render.com](https://render.com) → **New Web Service** → connect your GitHub repo
2. Set **Build Command**: `npm install`
3. Set **Start Command**: `node src/server.js`
4. Add environment variables (`JWT_SECRET`, etc.)
5. Add a **Persistent Disk** mounted at `/app/uploads`
6. Deploy!

> **Note**: Railway's free tier includes **500 MB** of volume storage, which aligns with your app's 500 MB quota. If you're on the Hobby plan, you get up to 5 GB.

## API Endpoints

| Endpoint | Method | Auth | Description |
|---|---|---|---|
| `/api/auth/register` | POST | No | Create account |
| `/api/auth/login` | POST | No | Login, returns JWT |
| `/api/auth/me` | GET | Yes | Current user info |
| `/api/files` | GET | No | List files (paginated, searchable) |
| `/api/files/upload` | POST | Yes | Upload a file |
| `/api/files/:id/download` | GET | No | Download a file |
| `/api/files/:id` | DELETE | Yes | Delete own file |
| `/api/files/storage-info` | GET | No | Storage usage stats |
| `/api/files/tags` | GET | No | All unique tags |

## License

MIT
