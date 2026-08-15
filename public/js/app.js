/* ═══════════════════════════════════════════════════════════════════════════
   Universal Downloader — Client-Side Logic
   ═══════════════════════════════════════════════════════════════════════════ */

// ── API Service ─────────────────────────────────────────────────────────────
const API = {
  base: '/api',

  _headers(isJson = true) {
    const h = {};
    if (isJson) h['Content-Type'] = 'application/json';
    const token = localStorage.getItem('ud_token');
    if (token) h['Authorization'] = `Bearer ${token}`;
    return h;
  },

  async request(method, path, body, isJson = true) {
    const opts = { method, headers: this._headers(isJson) };
    if (body) opts.body = isJson ? JSON.stringify(body) : body;
    const res = await fetch(`${this.base}${path}`, opts);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  },

  // Auth
  register: (d) => API.request('POST', '/auth/register', d),
  login:    (d) => API.request('POST', '/auth/login', d),
  me:       ()  => API.request('GET', '/auth/me'),

  // Files
  listFiles:   (params) => API.request('GET', `/files?${new URLSearchParams(params)}`),
  storageInfo: ()       => API.request('GET', '/files/storage-info'),
  getTags:     ()       => API.request('GET', '/files/tags'),
  deleteFile:  (id)     => API.request('DELETE', `/files/${id}`),

  uploadFile(file, tags, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${this.base}/files/upload`);

      const token = localStorage.getItem('ud_token');
      if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
      };
      xhr.onload = () => {
        try {
          const data = JSON.parse(xhr.responseText);
          if (xhr.status >= 200 && xhr.status < 300) resolve(data);
          else reject(new Error(data.error || 'Upload failed'));
        } catch { reject(new Error('Upload failed')); }
      };
      xhr.onerror = () => reject(new Error('Network error'));

      const fd = new FormData();
      fd.append('file', file);
      fd.append('tags', JSON.stringify(tags));
      xhr.send(fd);
    });
  }
};

// ── Auth State ──────────────────────────────────────────────────────────────
const Auth = {
  getToken: ()     => localStorage.getItem('ud_token'),
  getUser:  ()     => JSON.parse(localStorage.getItem('ud_user') || 'null'),
  isLoggedIn: ()   => !!Auth.getToken(),

  save(token, user) {
    localStorage.setItem('ud_token', token);
    localStorage.setItem('ud_user', JSON.stringify(user));
  },
  clear() {
    localStorage.removeItem('ud_token');
    localStorage.removeItem('ud_user');
  },
  logout() {
    Auth.clear();
    window.location.href = '/';
  }
};

// ── Toast Notifications ─────────────────────────────────────────────────────
const Toast = {
  container: null,
  init() {
    if (!this.container) {
      this.container = document.createElement('div');
      this.container.className = 'toast-container';
      document.body.appendChild(this.container);
    }
  },
  show(message, type = 'info', duration = 3500) {
    this.init();
    const icons = { success: '✓', error: '✕', info: 'ℹ' };
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.style.setProperty('--toast-duration', `${duration}ms`);
    toast.innerHTML = `<span>${icons[type] || 'ℹ'}</span><span>${message}</span>`;
    this.container.appendChild(toast);
    setTimeout(() => toast.remove(), duration + 400);
  },
  success: (msg) => Toast.show(msg, 'success'),
  error:   (msg) => Toast.show(msg, 'error'),
  info:    (msg) => Toast.show(msg, 'info'),
};

// ── Helpers ─────────────────────────────────────────────────────────────────
function formatSize(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(i > 1 ? 1 : 0) + ' ' + units[i];
}

function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr + 'Z').getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(dateStr + 'Z').toLocaleDateString();
}

function getFileExtension(name) {
  return (name.split('.').pop() || '').toUpperCase().slice(0, 5);
}

function getFileTypeClass(tags) {
  const cat = (tags && tags[0]) ? tags[0].toLowerCase() : 'other';
  return `type-${cat}`;
}

// ── Navigation Render ───────────────────────────────────────────────────────
function renderNav() {
  const navLinks = document.getElementById('nav-links');
  if (!navLinks) return;

  const currentPath = window.location.pathname;
  const loggedIn = Auth.isLoggedIn();
  const user = Auth.getUser();

  let html = `
    <a href="/" class="${currentPath === '/' ? 'nav-active' : ''}">🏠 Library</a>
  `;
  if (loggedIn) {
    html += `
      <a href="/dashboard.html" class="${currentPath.includes('dashboard') ? 'nav-active' : ''}">📤 Dashboard</a>
      <span style="color:var(--text-muted);font-size:0.85rem;padding:0 0.3rem">|</span>
      <span style="color:var(--accent-light);font-size:0.85rem;font-weight:500;padding:0 0.3rem">👤 ${user?.username || 'User'}</span>
      <button onclick="Auth.logout()" class="btn btn-sm btn-ghost">Logout</button>
    `;
  } else {
    html += `
      <a href="/auth.html" class="btn btn-sm btn-primary">Login / Register</a>
    `;
  }
  navLinks.innerHTML = html;
}

// ── File Card HTML ──────────────────────────────────────────────────────────
function isPreviewable(mimeType) {
  return mimeType && (mimeType.startsWith('image/') || mimeType === 'application/pdf');
}

function fileCardHTML(file, showDelete = false) {
  const ext = getFileExtension(file.original_name);
  const typeClass = getFileTypeClass(file.tags);
  const tagsHTML = (file.tags || []).map(t =>
    `<span class="mini-tag">${t}</span>`
  ).join('');

  const previewBtn = isPreviewable(file.mime_type)
    ? `<button class="btn btn-sm btn-secondary" onclick="window.open('/api/files/${file.id}/preview', '_blank')">👁 Preview</button>`
    : '';

  return `
    <div class="file-card" style="animation-delay: ${Math.random() * 0.15}s">
      <div class="file-card-header">
        <div class="file-type-badge ${typeClass}">${ext}</div>
        <div class="file-card-info">
          <div class="file-card-name" title="${file.original_name}">${file.original_name}</div>
          <div class="file-card-meta">
            <span>👤 ${file.uploader_name}</span>
            <span>💾 ${formatSize(file.size_bytes)}</span>
            <span>📥 ${file.download_count}</span>
            <span>🕐 ${timeAgo(file.uploaded_at)}</span>
          </div>
        </div>
      </div>
      ${tagsHTML ? `<div class="file-card-tags">${tagsHTML}</div>` : ''}
      <div class="file-card-actions">
        ${previewBtn}
        <button class="btn btn-sm btn-primary" onclick="window.location.href='/api/files/${file.id}/download'">⬇ Download</button>
        ${showDelete ? `<button class="btn btn-sm btn-danger" onclick="deleteFile('${file.id}')">🗑 Delete</button>` : ''}
      </div>
    </div>
  `;
}

// ═══════════════════════════════════════════════════════════════════════════
// PAGE: Library (index.html)
// ═══════════════════════════════════════════════════════════════════════════
async function initLibrary() {
  renderNav();
  loadStorageBar();
  loadTags();
  loadFiles();

  const searchInput = document.getElementById('search-input');
  if (searchInput) {
    let debounce;
    searchInput.addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => loadFiles(), 300);
    });
  }
}

let currentPage = 1;
let currentTag = '';

async function loadStorageBar() {
  try {
    const info = await API.storageInfo();
    const pct = Math.min(100, (info.totalUsed / info.totalLimit) * 100);
    const fill = document.getElementById('storage-fill');
    const label = document.getElementById('storage-label');
    if (fill) {
      fill.style.width = pct + '%';
      if (pct > 85) fill.classList.add('warning');
    }
    if (label) label.textContent = `${formatSize(info.totalUsed)} / ${formatSize(info.totalLimit)} used`;
  } catch (_) {}
}

async function loadTags() {
  try {
    const { tags } = await API.getTags();
    const container = document.getElementById('tags-filter');
    if (!container) return;

    let html = `<button class="tag-pill ${!currentTag ? 'active' : ''}" onclick="filterByTag('')">All</button>`;
    const predef = ['Documents', 'Images', 'Archives', 'Video', 'Audio', 'Code', 'Other'];
    const allTags = [...new Set([...predef, ...tags])];
    allTags.forEach(t => {
      html += `<button class="tag-pill ${currentTag === t ? 'active' : ''}" onclick="filterByTag('${t}')">${t}</button>`;
    });
    container.innerHTML = html;
  } catch (_) {}
}

function filterByTag(tag) {
  currentTag = tag;
  currentPage = 1;
  loadTags();
  loadFiles();
}

async function loadFiles() {
  const grid = document.getElementById('files-grid');
  if (!grid) return;

  const params = { page: currentPage, limit: 24 };
  const search = document.getElementById('search-input')?.value;
  if (search) params.search = search;
  if (currentTag) params.tag = currentTag;

  // Show skeletons
  grid.innerHTML = Array(6).fill('<div class="skeleton skeleton-card"></div>').join('');

  try {
    const data = await API.listFiles(params);

    if (data.files.length === 0) {
      grid.innerHTML = `
        <div class="empty-state" style="grid-column:1/-1">
          <div class="empty-icon">📭</div>
          <h3>No files found</h3>
          <p>${search ? 'Try a different search term' : 'Be the first to upload a file!'}</p>
        </div>
      `;
    } else {
      grid.innerHTML = data.files.map(f => fileCardHTML(f, false)).join('');
    }

    renderPagination(data.page, data.totalPages);
  } catch (err) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><h3>Failed to load files</h3><p>${err.message}</p></div>`;
  }
}

function renderPagination(page, totalPages) {
  const container = document.getElementById('pagination');
  if (!container || totalPages <= 1) {
    if (container) container.innerHTML = '';
    return;
  }
  let html = `<button class="btn btn-sm btn-secondary" ${page <= 1 ? 'disabled' : ''} onclick="goToPage(${page - 1})">← Prev</button>`;
  html += `<span style="color:var(--text-muted);font-size:0.85rem">${page} / ${totalPages}</span>`;
  html += `<button class="btn btn-sm btn-secondary" ${page >= totalPages ? 'disabled' : ''} onclick="goToPage(${page + 1})">Next →</button>`;
  container.innerHTML = html;
}

function goToPage(page) {
  currentPage = page;
  loadFiles();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ═══════════════════════════════════════════════════════════════════════════
// PAGE: Auth (auth.html)
// ═══════════════════════════════════════════════════════════════════════════
function initAuth() {
  renderNav();

  // Redirect if already logged in
  if (Auth.isLoggedIn()) {
    window.location.href = '/dashboard.html';
    return;
  }

  const loginTab = document.getElementById('login-tab');
  const registerTab = document.getElementById('register-tab');
  const loginForm = document.getElementById('login-form');
  const registerForm = document.getElementById('register-form');

  if (loginTab) loginTab.addEventListener('click', () => switchAuthTab('login'));
  if (registerTab) registerTab.addEventListener('click', () => switchAuthTab('register'));

  if (loginForm) loginForm.addEventListener('submit', handleLogin);
  if (registerForm) registerForm.addEventListener('submit', handleRegister);
}

function switchAuthTab(tab) {
  document.getElementById('login-tab').classList.toggle('active', tab === 'login');
  document.getElementById('register-tab').classList.toggle('active', tab === 'register');
  document.getElementById('login-form').classList.toggle('hidden', tab !== 'login');
  document.getElementById('register-form').classList.toggle('hidden', tab !== 'register');
  document.querySelectorAll('.auth-error').forEach(e => e.classList.remove('visible'));
}

async function handleLogin(e) {
  e.preventDefault();
  const errEl = document.getElementById('login-error');
  const btn = e.target.querySelector('button[type="submit"]');
  errEl.classList.remove('visible');
  btn.disabled = true;
  btn.innerHTML = '<div class="spinner"></div>';

  try {
    const email = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;
    const { token, user } = await API.login({ email, password });
    Auth.save(token, user);
    Toast.success('Welcome back, ' + user.username + '!');
    setTimeout(() => window.location.href = '/dashboard.html', 500);
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.add('visible');
    btn.disabled = false;
    btn.textContent = 'Login';
  }
}

async function handleRegister(e) {
  e.preventDefault();
  const errEl = document.getElementById('register-error');
  const btn = e.target.querySelector('button[type="submit"]');
  errEl.classList.remove('visible');
  btn.disabled = true;
  btn.innerHTML = '<div class="spinner"></div>';

  try {
    const username = document.getElementById('register-username').value.trim();
    const email = document.getElementById('register-email').value.trim();
    const password = document.getElementById('register-password').value;
    const { token, user } = await API.register({ username, email, password });
    Auth.save(token, user);
    Toast.success('Account created! Welcome, ' + user.username + '!');
    setTimeout(() => window.location.href = '/dashboard.html', 500);
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.add('visible');
    btn.disabled = false;
    btn.textContent = 'Create Account';
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// PAGE: Dashboard (dashboard.html)
// ═══════════════════════════════════════════════════════════════════════════
let selectedFile = null;
let uploadTags = [];

function initDashboard() {
  renderNav();

  if (!Auth.isLoggedIn()) {
    window.location.href = '/auth.html';
    return;
  }

  setupUploadZone();
  setupTagInput();
  loadMyFiles();
  loadStorageBar();

  const user = Auth.getUser();
  const greeting = document.getElementById('dashboard-greeting');
  if (greeting) greeting.textContent = `Welcome, ${user?.username || 'User'}`;
}

function setupUploadZone() {
  const zone = document.getElementById('upload-zone');
  const fileInput = document.getElementById('file-input');
  if (!zone || !fileInput) return;

  zone.addEventListener('click', () => fileInput.click());
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('dragover'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('dragover');
    if (e.dataTransfer.files.length) selectFile(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files.length) selectFile(fileInput.files[0]);
  });
}

function selectFile(file) {
  selectedFile = file;
  const form = document.getElementById('upload-form');
  const previewName = document.getElementById('preview-name');
  const previewSize = document.getElementById('preview-size');

  if (previewName) previewName.textContent = file.name;
  if (previewSize) previewSize.textContent = formatSize(file.size);
  if (form) form.classList.add('visible');
}

function clearSelectedFile() {
  selectedFile = null;
  uploadTags = [];
  document.getElementById('upload-form')?.classList.remove('visible');
  document.getElementById('file-input').value = '';
  renderTagChips();
}

function setupTagInput() {
  const input = document.getElementById('tag-text-input');
  if (!input) return;

  input.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ',') && input.value.trim()) {
      e.preventDefault();
      addTag(input.value.trim().replace(',', ''));
      input.value = '';
    }
    if (e.key === 'Backspace' && !input.value && uploadTags.length) {
      uploadTags.pop();
      renderTagChips();
    }
  });
}

function addTag(tag) {
  const cleaned = tag.trim();
  if (cleaned && !uploadTags.includes(cleaned) && uploadTags.length < 10) {
    uploadTags.push(cleaned);
    renderTagChips();
  }
}

function removeTag(index) {
  uploadTags.splice(index, 1);
  renderTagChips();
}

function renderTagChips() {
  const container = document.getElementById('tag-chips');
  if (!container) return;
  container.innerHTML = uploadTags.map((t, i) =>
    `<span class="tag-chip">${t}<span class="remove-tag" onclick="removeTag(${i})">×</span></span>`
  ).join('');
}

async function handleUpload() {
  if (!selectedFile) return Toast.error('No file selected');

  const btn = document.getElementById('upload-btn');
  const progress = document.getElementById('upload-progress');
  const progressFill = document.getElementById('progress-fill');
  const progressText = document.getElementById('progress-text');

  btn.disabled = true;
  progress.classList.add('visible');

  try {
    await API.uploadFile(selectedFile, uploadTags, (pct) => {
      progressFill.style.width = pct + '%';
      progressText.textContent = pct < 100 ? `Uploading... ${pct}%` : 'Processing...';
    });

    Toast.success('File uploaded successfully!');
    clearSelectedFile();
    progress.classList.remove('visible');
    progressFill.style.width = '0%';
    loadMyFiles();
    loadStorageBar();
  } catch (err) {
    Toast.error(err.message);
    progress.classList.remove('visible');
  } finally {
    btn.disabled = false;
  }
}

async function loadMyFiles() {
  const grid = document.getElementById('my-files-grid');
  const count = document.getElementById('my-files-count');
  if (!grid) return;

  grid.innerHTML = Array(3).fill('<div class="skeleton skeleton-card"></div>').join('');

  try {
    // Load all files and filter by current user
    const user = Auth.getUser();
    const data = await API.listFiles({ limit: 100 });
    const myFiles = data.files.filter(f => f.user_id === user.id);

    if (count) count.textContent = `${myFiles.length} file${myFiles.length !== 1 ? 's' : ''}`;

    if (myFiles.length === 0) {
      grid.innerHTML = `
        <div class="empty-state" style="grid-column:1/-1">
          <div class="empty-icon">📁</div>
          <h3>No files yet</h3>
          <p>Upload your first file above!</p>
        </div>
      `;
    } else {
      grid.innerHTML = myFiles.map(f => fileCardHTML(f, true)).join('');
    }
  } catch (err) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><h3>Failed to load</h3></div>`;
  }
}

async function deleteFile(id) {
  if (!confirm('Are you sure you want to delete this file?')) return;

  try {
    await API.deleteFile(id);
    Toast.success('File deleted');
    loadMyFiles();
    loadStorageBar();
  } catch (err) {
    Toast.error(err.message);
  }
}

// ── Page Router ─────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const page = document.body.dataset.page;
  if (page === 'library') initLibrary();
  else if (page === 'auth') initAuth();
  else if (page === 'dashboard') initDashboard();
});
