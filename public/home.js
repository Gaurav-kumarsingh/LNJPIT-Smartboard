/* ═══════════════════════════════════════════════════════════════
   SMARTBOARD — HOME.JS
   Dashboard logic: auth, files, calendar, clock, widgets
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const API = '';  // same-origin (backend serves frontend on the same domain)

// ═══════════════════════════════════════════════════
// SECURITY: Safe HTML Escaping
// ═══════════════════════════════════════════════════
function escHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function safeOpen(url) {
  try {
    // Validate URL is relative or same-origin
    const parsed = new URL(url, window.location.origin);
    if (!parsed.href.startsWith(window.location.origin) && !url.startsWith('/')) {
      console.warn('Unsafe URL blocked:', url);
      return false;
    }
    window.open(url, '_blank');
    return true;
  } catch (e) {
    console.warn('Invalid URL:', url, e);
    return false;
  }
}

// ═══════════════════════════════════════════════════
// 1. STATE
// ═══════════════════════════════════════════════════
let authToken   = localStorage.getItem('sb_token') || null;
let currentUser = JSON.parse(localStorage.getItem('sb_user') || 'null');
let tokenExpiry = parseInt(localStorage.getItem('sb_token_expiry') || '0', 10);
let adminAuthed = false;
let allFiles    = [];
let reminders   = JSON.parse(localStorage.getItem('sb_reminders') || '[]');
let boardConfigs= JSON.parse(localStorage.getItem('sb_boards') || '{}');
let calDate     = new Date();
let toastTimer  = null;
let livePreviewEnabled = localStorage.getItem('sb_live_preview') !== 'false';

// ── Proactive token expiry check ────────────────────────────────────────────────────
// If the stored token is already expired, clear it immediately on page load
// to avoid confusing 401 errors on first API call.
if (authToken && tokenExpiry && Date.now() > tokenExpiry) {
  authToken = null; currentUser = null; tokenExpiry = 0;
  localStorage.removeItem('sb_token');
  localStorage.removeItem('sb_user');
  localStorage.removeItem('sb_token_expiry');
}

// ═══════════════════════════════════════════════════
// 2. INIT
// ═══════════════════════════════════════════════════
window.addEventListener('DOMContentLoaded', async () => {
  applyTheme(localStorage.getItem('sb_theme') || 'dark');
  applyBoardConfigs();
  updateNavUser();
  renderClock();
  renderCalendar();
  loadNotes();
  setupSearch();
  setupDragDrop();
  setupModalOverlayClose();
  setInterval(renderClock, 1000);

  // Render free-tier: backend may be sleeping (cold start ~15-30s).
  // Ping /api/health first; show a friendly banner while waiting.
  await wakeUpBackend();
  loadFiles();

  // ── Keep-alive: ping /api/health every 9 min to prevent Render sleep ────
  // Render free-tier sleeps after 15 min of inactivity. This runs as long
  // as any user has the dashboard open — effectively keeping the server warm.
  setInterval(async () => {
    try {
      await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(8_000) });
    } catch (_) { /* silent — don't disturb the user */ }
  }, 9 * 60 * 1000); // 9 minutes
});

// ═══════════════════════════════════════════════════
// BACKEND WAKE-UP (Render cold-start handler)
// Pings /api/health with retries. If backend is sleeping,
// Render takes ~15-30s to wake it. We wait gracefully.
// ═══════════════════════════════════════════════════
async function wakeUpBackend() {
  const MAX_WAIT_MS   = 45_000;  // give Render up to 45s to wake
  const POLL_INTERVAL = 3_000;
  const start         = Date.now();

  // Show a subtle status bar at the top so users aren't confused
  let banner = document.getElementById('backend-status-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'backend-status-banner';
    Object.assign(banner.style, {
      position: 'fixed', top: '0', left: '0', right: '0', zIndex: '9999',
      background: '#f59e0b', color: '#1a1a1a', textAlign: 'center',
      padding: '8px 16px', fontSize: '13px', fontWeight: '600',
      display: 'none', transition: 'opacity 0.3s',
    });
    document.body.prepend(banner);
  }

  while (Date.now() - start < MAX_WAIT_MS) {
    try {
      const res = await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(8_000) });
      if (res.ok) {
        banner.style.display = 'none';
        return; // backend is alive and MongoDB is connected
      }
      // 503 = backend up but DB not connected yet — keep waiting
    } catch (_) { /* network error / timeout — keep trying */ }

    const elapsed = Math.floor((Date.now() - start) / 1000);
    banner.textContent = `⏳ Connecting to server… (${elapsed}s) — Please wait`;
    banner.style.display = 'block';
    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }

  // Gave up — show a persistent error message
  banner.style.background = '#ef4444';
  banner.style.color = '#fff';
  banner.textContent = '⚠️ Server is taking too long to respond. Try refreshing in 30 seconds.';
}

// ═══════════════════════════════════════════════════
// 3. THEME
// ═══════════════════════════════════════════════════
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  localStorage.setItem('sb_theme', t);
  const icon = document.querySelector('#btn-theme i');
  if (icon) icon.className = t === 'dark' ? 'fas fa-moon' : 'fas fa-sun';
}
function toggleTheme() {
  const cur = document.documentElement.dataset.theme;
  applyTheme(cur === 'dark' ? 'light' : 'dark');
}

// ✅ SEARCH FUNCTIONALITY (was missing)
function openSearch(engine) {
  const query = document.getElementById('global-search').value.trim();
  if (!query) {
    showToast('Enter a search query', true);
    return;
  }
  
  const urls = {
    'chatgpt': `https://chat.openai.com/?q=${encodeURIComponent(query)}`,
    'gemini': `https://gemini.google.com/app?query=${encodeURIComponent(query)}`,
    'google': `https://www.google.com/search?q=${encodeURIComponent(query)}`
  };
  
  if (urls[engine]) {
    window.open(urls[engine], '_blank');
  } else {
    showToast('Search engine not supported', true);
  }
}

// ═══════════════════════════════════════════════════
// 4. AUTH
// ═══════════════════════════════════════════════════
function updateNavUser() {
  const lbl = document.getElementById('nav-user-label');
  const btn = document.getElementById('btn-user');
  if (currentUser) {
    lbl.textContent = currentUser.username || currentUser.email || 'User';
    btn.title = 'Logged in as ' + (currentUser.username || currentUser.email);
    btn.querySelector('i').className = 'fas fa-user-check';
  } else {
    lbl.textContent = 'Sign In';
    btn.querySelector('i').className = 'fas fa-user-circle';
  }
}

function handleUserAction() {
  if (currentUser) {
    if (confirm('Sign out?')) {
      const token = authToken;
      authToken = null; currentUser = null; tokenExpiry = 0;
      localStorage.removeItem('sb_token');
      localStorage.removeItem('sb_user');
      localStorage.removeItem('sb_token_expiry');
      updateNavUser();
      showToast('Signed out');
      if (token) {
        fetch(`${API}/api/logout`, {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + token }
        }).catch(() => {});
      }
    }
  } else {
    openModal('modal-login');
  }
}

async function doLogin(e) {
  e.preventDefault();
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  const errEl = document.getElementById('login-error');
  const submitBtn = document.getElementById('login-submit');

  errEl.classList.add('hidden');
  submitBtn.querySelector('.btn-text').classList.add('hidden');
  submitBtn.querySelector('.btn-spinner').classList.remove('hidden');
  submitBtn.disabled = true;

  try {
    const res = await fetch(`${API}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
      signal: AbortSignal.timeout(10000)  // ✅ 10 second timeout
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Login failed');

    authToken   = data.token;
    currentUser = data.user;
    tokenExpiry = data.expiresAt || (Date.now() + 7 * 24 * 60 * 60 * 1000);
    localStorage.setItem('sb_token',        authToken);
    localStorage.setItem('sb_user',         JSON.stringify(currentUser));
    localStorage.setItem('sb_token_expiry', String(tokenExpiry));
    closeModal('modal-login');
    updateNavUser();
    loadFiles();
    showToast('Welcome, ' + (currentUser.username || 'User') + '!');
  } catch (err) {
    errEl.textContent = err.message; errEl.classList.remove('hidden');
  } finally {
    submitBtn.querySelector('.btn-text').classList.remove('hidden');
    submitBtn.querySelector('.btn-spinner').classList.add('hidden');
    submitBtn.disabled = false;
  }
}

// ═══════════════════════════════════════════════════
// handleAuthError — called by any fetch wrapper when it gets a 401/403
// Clears the session and prompts the user to log in again.
// ═══════════════════════════════════════════════════
function handleAuthError(data, res) {
  const code = data?.code;
  if (res.status === 401 && (code === 'TOKEN_EXPIRED' || code === 'NO_TOKEN')) {
    // Clear stale session silently and open login modal
    authToken = null; currentUser = null; tokenExpiry = 0;
    localStorage.removeItem('sb_token');
    localStorage.removeItem('sb_user');
    localStorage.removeItem('sb_token_expiry');
    updateNavUser();
    showToast('Your session expired. Please sign in again.', true);
    setTimeout(() => openModal('modal-login'), 500);
    return true; // handled
  }
  return false; // not an auth error
}


// ═══════════════════════════════════════════════════
// 5. ADMIN AUTH
// ═══════════════════════════════════════════════════
function openAdminSettings() {
  openModal('modal-admin');
  document.getElementById('admin-login-gate').classList.remove('hidden');
  document.getElementById('admin-panel-content').classList.add('hidden');
  adminAuthed = false;
}

async function doAdminLogin(e) {
  e.preventDefault();
  const username = document.getElementById('admin-login-user').value.trim();
  const password = document.getElementById('admin-login-pw').value;
  const errEl = document.getElementById('admin-login-error');
  errEl.classList.add('hidden');

  try {
    const res = await fetch(`${API}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
      signal: AbortSignal.timeout(10000)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Invalid credentials');

    adminAuthed = true;
    document.getElementById('admin-login-gate').classList.add('hidden');
    document.getElementById('admin-panel-content').classList.remove('hidden');
    // Store admin token temporarily
    window._adminToken = data.token;
    loadAdminData();
  } catch (err) {
    errEl.textContent = err.message; errEl.classList.remove('hidden');
  }
}

function switchAdminTab(tab, btn) {
  document.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.admin-tab-content').forEach(c => c.classList.add('hidden'));
  if (btn) btn.classList.add('active');
  else {
    const el = document.querySelector(`[data-tab="${tab}"]`);
    if (el) el.classList.add('active');
  }
  document.getElementById('tab-' + tab).classList.remove('hidden');
  loadAdminTabContent(tab);
}

async function loadAdminData() {
  loadAdminTabContent('users');
  loadAnalytics();
  // Load live preview toggle state
  document.getElementById('toggle-live-preview').checked = livePreviewEnabled;
}

async function loadAdminTabContent(tab) {
  if (tab === 'users') await loadAdminUsers();
  else if (tab === 'files') await loadAdminFiles();
  else if (tab === 'boards') loadAdminBoards();
  else if (tab === 'analytics') loadAnalytics();
}

async function loadAdminUsers() {
  const el = document.getElementById('users-list');
  el.innerHTML = '<div style="color:var(--text-2);font-size:12px;padding:10px">Loading...</div>';
  try {
    const res = await fetchWithRetry(`${API}/api/admin/users`, {
      headers: { 'Authorization': 'Bearer ' + window._adminToken }
    });
    const users = await res.json();
    if (!users.length) { el.innerHTML = '<div class="empty-admin">No users yet. Create one!</div>'; return; }
    el.innerHTML = '';
    users.forEach(u => {
      const item = document.createElement('div');
      item.className = 'admin-list-item';
      
      // ✅ Build safe HTML structure
      const icon = document.createElement('div');
      icon.className = 'alist-icon';
      icon.style.background = 'var(--accent-glow)';
      icon.style.color = 'var(--accent-2)';
      icon.innerHTML = '<i class="fas fa-user"></i>';
      
      const name = document.createElement('div');
      name.className = 'alist-name';
      name.textContent = u.username;  // ✅ Safe - textContent
      
      const meta = document.createElement('div');
      meta.className = 'alist-meta';
      meta.textContent = `ID: ${u.id}`;  // ✅ Safe - textContent
      
      const info = document.createElement('div');
      info.appendChild(name);
      info.appendChild(meta);
      
      // ✅ Safe delete button without injection risk
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'alist-btn danger';
      deleteBtn.innerHTML = '<i class="fas fa-trash"></i> Delete';
      deleteBtn.onclick = () => deleteUser(u.id);  // ✅ Direct function call, not inline onclick
      
      const actions = document.createElement('div');
      actions.className = 'alist-actions';
      actions.appendChild(deleteBtn);
      
      item.appendChild(icon);
      item.appendChild(info);
      item.appendChild(actions);
      el.appendChild(item);
    });
    document.getElementById('stat-users').textContent = users.length;
  } catch { el.innerHTML = '<div class="empty-admin" style="color:var(--danger)">Failed to load users</div>'; }
}

async function loadAdminFiles() {
  const el = document.getElementById('admin-files-list');
  el.innerHTML = '<div style="color:var(--text-2);font-size:12px;padding:10px">Loading...</div>';
  try {
    const res = await fetchWithRetry(`${API}/api/admin/files`, {
      headers: { 'Authorization': 'Bearer ' + window._adminToken }
    });
    const files = await res.json();
    el.innerHTML = '';
    if (!files.length) { el.innerHTML = '<div class="empty-admin">No files uploaded yet.</div>'; return; }
    files.forEach(f => {
      const ext = f.original_name.split('.').pop().toLowerCase();
      const isImg = ['jpg','jpeg','png','gif','webp'].includes(ext);
      const isPdf = ext === 'pdf';
      const isVid = ['mp4','webm'].includes(ext);
      const icon = isPdf ? '📄' : isImg ? '🖼️' : isVid ? '🎬' : '📎';
      
      const item = document.createElement('div');
      item.className = 'admin-list-item';
      
      // ✅ Build safe HTML structure
      const iconEl = document.createElement('div');
      iconEl.className = 'alist-icon';
      iconEl.style.fontSize = '18px';
      iconEl.textContent = icon;
      
      const nameEl = document.createElement('div');
      nameEl.className = 'alist-name';
      nameEl.textContent = f.original_name;  // ✅ Safe
      
      const metaEl = document.createElement('div');
      metaEl.className = 'alist-meta';
      metaEl.textContent = `Board ${f.board_id}${f.subject ? ' · ' + f.subject : ''} · ${formatDate(f.uploaded_at)}`;  // ✅ Safe
      
      const info = document.createElement('div');
      info.appendChild(nameEl);
      info.appendChild(metaEl);
      
      // ✅ Safe view button
      const viewBtn = document.createElement('button');
      viewBtn.className = 'alist-btn';
      viewBtn.innerHTML = '<i class="fas fa-eye"></i>';
      viewBtn.onclick = () => {
        const uploadUrl = `/uploads/${f.filename}`;
        safeOpen(uploadUrl);  // ✅ Use safe open function
      };
      
      // ✅ Safe delete button
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'alist-btn danger';
      deleteBtn.innerHTML = '<i class="fas fa-trash"></i>';
      deleteBtn.onclick = () => adminDeleteFile(f.id);
      
      const actions = document.createElement('div');
      actions.className = 'alist-actions';
      actions.appendChild(viewBtn);
      actions.appendChild(deleteBtn);
      
      item.appendChild(iconEl);
      item.appendChild(info);
      item.appendChild(actions);
      el.appendChild(item);
    });
    document.getElementById('stat-files').textContent = files.length;
  } catch (err) { 
    console.error('[LoadAdminFiles]', err);
    el.innerHTML = '<div style="color:var(--danger)">Failed to load files</div>'; 
  }
}

async function loadAdminBoards() {
  const el = document.getElementById('admin-boards-list');
  el.innerHTML = '<div style="color:var(--text-2);font-size:12px;padding:10px">Checking statuses...</div>';
  
  let statuses = {};
  try {
    const sres = await fetchWithRetry(`${API}/api/admin/board-status`, {
      headers: { 'Authorization': 'Bearer ' + window._adminToken }
    });
    statuses = await sres.json();
  } catch (e) {
    console.warn('[LoadAdminBoards]', e);
  }

  el.innerHTML = '';
  [1,2,3,4,5].forEach(id => {
    const cfg = boardConfigs[id] || {};
    const s = statuses[id] || { isActive: false };
    const liveColor = s.isActive ? '#10b981' : '#6b7280';

    const item = document.createElement('div');
    item.className = 'admin-list-item';

    const icon = document.createElement('div');
    icon.className = 'alist-icon';
    icon.style.background = 'var(--accent-glow)';
    icon.style.color = 'var(--accent-2)';
    icon.style.fontWeight = '800';
    icon.style.fontSize = '14px';
    icon.textContent = String(id);
    if (s.isActive) {
      const badge = document.createElement('div');
      badge.style.position = 'absolute';
      badge.style.top = '-2px';
      badge.style.right = '-2px';
      badge.style.width = '10px';
      badge.style.height = '10px';
      badge.style.background = '#10b981';
      badge.style.borderRadius = '50%';
      badge.style.border = '2px solid var(--bg-1)';
      icon.appendChild(badge);
    }

    const info = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'alist-name';
    title.textContent = 'Board 0' + id;

    const subtitle = document.createElement('div');
    subtitle.className = 'alist-meta';
    subtitle.textContent = id === 1 ? (cfg.subject || 'Core Subjects') : (cfg.subject || 'Not configured');

    info.appendChild(title);
    info.appendChild(subtitle);

    const actions = document.createElement('div');
    actions.className = 'alist-actions';
    actions.style.gap = '5px';

    const liveBtn = document.createElement('button');
    liveBtn.className = 'alist-btn';
    liveBtn.type = 'button';
    liveBtn.title = 'Live Preview';
    liveBtn.style.background = liveColor;
    liveBtn.style.color = 'white';
    liveBtn.style.border = 'none';
    liveBtn.disabled = !s.isActive;
    liveBtn.innerHTML = '<i class="fas fa-satellite-dish"></i> Live';
    liveBtn.onclick = () => openBoardLive(id);

    const pdfBtn = document.createElement('button');
    pdfBtn.className = 'alist-btn';
    pdfBtn.type = 'button';
    pdfBtn.style.background = '#007bff';
    pdfBtn.style.color = 'white';
    pdfBtn.style.border = 'none';
    pdfBtn.title = 'Download PDF';
    pdfBtn.innerHTML = '<i class="fas fa-download"></i> Download PDF';
    pdfBtn.onclick = () => downloadBoardPDF(id);

    const routineBtn = document.createElement('button');
    routineBtn.className = 'alist-btn';
    routineBtn.type = 'button';
    routineBtn.style.background = '#f59e0b';
    routineBtn.style.color = 'white';
    routineBtn.style.border = 'none';
    routineBtn.title = 'Upload Routine';
    routineBtn.innerHTML = '<i class="fas fa-calendar-plus"></i> Routine';
    routineBtn.onclick = () => triggerAdminRoutineUploadBoard(id);

    const editBtn = document.createElement('button');
    editBtn.className = 'alist-btn';
    editBtn.type = 'button';
    editBtn.innerHTML = '<i class="fas fa-edit"></i> Edit';
    editBtn.onclick = () => adminConfigBoard(id);

    const clearBtn = document.createElement('button');
    clearBtn.className = 'alist-btn danger';
    clearBtn.type = 'button';
    clearBtn.innerHTML = '<i class="fas fa-ban"></i> Clear';
    clearBtn.onclick = () => adminClearBoard(id);

    actions.appendChild(liveBtn);
    actions.appendChild(pdfBtn);
    actions.appendChild(routineBtn);
    actions.appendChild(editBtn);
    actions.appendChild(clearBtn);

    item.appendChild(icon);
    item.appendChild(info);
    item.appendChild(actions);
    el.appendChild(item);
  });
}


function openBoardLive(id) {
  const params = new URLSearchParams({ board: id, live: 'true' });
  window.open('board.html?' + params.toString(), '_blank');
}

async function downloadBoardPDF(id) {
  try {
    const res = await fetchWithRetry(`${API}/api/admin/export-board-pdf/${id}`, {
      headers: { 'Authorization': 'Bearer ' + window._adminToken }
    });
    const data = await res.json();
    if (res.ok && data.success && data.downloadUrl) {
      window.open(data.downloadUrl, '_blank');
    } else {
      throw new Error(data.error || 'Failed to generate PDF');
    }
  } catch (err) {
    console.error('[DownloadBoardPDF]', err);
    showToast('Error downloading PDF', true);
  }
}

async function loadAnalytics() {
  try {
    const [filesRes, usersRes] = await Promise.all([
      fetchWithRetry(`${API}/api/admin/files`, { headers: { 'Authorization': 'Bearer ' + window._adminToken } }),
      fetchWithRetry(`${API}/api/admin/users`, { headers: { 'Authorization': 'Bearer ' + window._adminToken } })
    ]);
    const files = await filesRes.json();
    const users = await usersRes.json();
    document.getElementById('stat-files').textContent = files.length;
    document.getElementById('stat-users').textContent = users.length;

    const recent = document.getElementById('recent-activity');
    recent.innerHTML = '';
    files.slice(0, 5).reverse().forEach(f => {
      const item = document.createElement('div');
      item.className = 'recent-item';

      const icon = document.createElement('span');
      icon.className = 'recent-icon';
      icon.textContent = '📁';

      const text = document.createElement('span');
      text.textContent = `Uploaded: ${f.original_name}`;

      const time = document.createElement('span');
      time.className = 'recent-time';
      time.textContent = formatDate(f.uploaded_at);

      item.appendChild(icon);
      item.appendChild(text);
      item.appendChild(time);
      recent.appendChild(item);
    });
  } catch (err) {
    console.error('[LoadAnalytics]', err);
  }
}

function openCreateUser() { openModal('modal-create-user'); }

async function doCreateUser(e) {
  e.preventDefault();
  const username = document.getElementById('new-user-name').value.trim();
  const password = document.getElementById('new-user-pw').value;
  const errEl = document.getElementById('create-user-error');
  errEl.classList.add('hidden');
  try {
    const res = await fetch(`${API}/api/admin/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + window._adminToken },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed');
    closeModal('modal-create-user');
    loadAdminUsers();
    showToast('User "' + username + '" created!');
  } catch (err) { errEl.textContent = err.message; errEl.classList.remove('hidden'); }
}

async function deleteUser(id) {
  if (!confirm('Delete this user?')) return;
  await fetch(`${API}/api/admin/users/${id}`, {
    method: 'DELETE',
    headers: { 'Authorization': 'Bearer ' + window._adminToken }
  });
  loadAdminUsers();
  showToast('User deleted');
}

async function adminDeleteFile(id) {
  if (!confirm('Delete this file?')) return;
  await fetch(`${API}/api/files/${id}`, {
    method: 'DELETE',
    headers: { 'Authorization': 'Bearer ' + window._adminToken }
  });
  loadAdminFiles();
  loadFiles();
  showToast('File deleted');
}

function adminConfigBoard(id) {
  document.getElementById('board-config-id').value = id;
  document.getElementById('board-subject-input').value = boardConfigs[id]?.subject || '';
  openModal('modal-configure-board');
}

function adminClearBoard(id) {
  if (!confirm('Clear configuration for Board 0' + id + '?')) return;
  delete boardConfigs[id];
  localStorage.setItem('sb_boards', JSON.stringify(boardConfigs));
  loadAdminBoards();
  applyBoardConfigs();
  showToast('Board 0' + id + ' cleared');
}

function triggerAdminUpload() {
  document.getElementById('admin-file-input').click();
}

function triggerAdminRoutineUpload() {
  window._uploadTargetBoard = 0; // Default global
  document.getElementById('admin-routine-input').click();
}

function triggerAdminRoutineUploadBoard(id) {
  window._uploadTargetBoard = id;
  document.getElementById('admin-routine-input').click();
}

async function doAdminRoutineUpload(input) {
  const files = input.files;
  if (!files.length) return;
  const boardId = window._uploadTargetBoard !== undefined ? window._uploadTargetBoard : 0;
  
  const fd = new FormData();
  for (const f of files) fd.append('file', f);
  fd.append('board_id', boardId);
  fd.append('subject', 'ROUTINE');

  // Admin uses admin token, but /api/upload validates the user JWT.
  // Use admin token which is also accepted by the authenticate middleware.
  const token = window._adminToken;
  if (!token) { showToast('Admin session expired. Please log in again.', true); input.value = ''; return; }

  try {
    const res = await fetchWithRetry(`${API}/api/upload`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token },
      body: fd
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Upload failed (HTTP ${res.status})`);
    loadAdminFiles();
    loadFiles();
    showToast('Routine for Board ' + (boardId === 0 ? 'Global' : '0'+boardId) + ' updated!');
  } catch (err) {
    showToast('Routine upload failed: ' + err.message, true);
    console.error('[RoutineUpload]', err);
  }
  input.value = '';
}

async function doAdminUpload(input) {
  const files = input.files;
  if (!files.length) return;
  const selectEl = document.getElementById('admin-upload-board');
  const boardId = selectEl.value;
  const subject = selectEl.options[selectEl.selectedIndex].dataset.subject || '';

  const token = window._adminToken;
  if (!token) { showToast('Admin session expired. Please log in again.', true); input.value = ''; return; }

  const fd = new FormData();
  for (const f of files) fd.append('file', f);
  fd.append('board_id', boardId);
  fd.append('subject', subject);

  try {
    const res = await fetchWithRetry(`${API}/api/upload`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token },
      body: fd
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Upload failed (HTTP ${res.status})`);
    loadAdminFiles();
    loadFiles();
    showNotif('New file uploaded by admin!');
    showToast(`File(s) uploaded successfully`);
  } catch (err) {
    showToast('Upload failed: ' + err.message, true);
    console.error('[AdminUpload]', err);
  }
  input.value = '';
}

// ═══════════════════════════════════════════════════════════
// UTILITY: fetchWithRetry — retries on network errors & 5xx
// Does NOT retry on 4xx (client error) — that would be wasteful.
// Automatically handles 401 TOKEN_EXPIRED → logs user out.
// ═══════════════════════════════════════════════════════════
async function fetchWithRetry(url, options = {}, retries = 3, delayMs = 1500) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      // 2-minute abort for uploads; 30s for normal requests
      const timeoutMs = options.body instanceof FormData ? 120_000 : 30_000;
      const tid = setTimeout(() => controller.abort(), timeoutMs);
      const res  = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(tid);

      // ── 4xx errors: don't retry, return immediately so callers can handle ──
      if (res.status >= 400 && res.status < 500) {
        // Special case: auto-handle expired session
        if (res.status === 401) {
          try {
            const clone = res.clone();
            const data  = await clone.json();
            handleAuthError(data, res);
          } catch(_) {}
        }
        return res;
      }

      // ── 5xx: server error — worth retrying ───────────────────────────────
      if (res.status >= 500 && attempt < retries) {
        console.warn(`[fetchWithRetry] Server error ${res.status} on attempt ${attempt}/${retries} — retrying…`);
        await new Promise(r => setTimeout(r, delayMs * attempt));
        continue;
      }

      return res; // 2xx / 3xx or final 5xx attempt
    } catch (err) {
      const isLast  = attempt === retries;
      const isAbort = err.name === 'AbortError';
      console.warn(`[fetchWithRetry] Attempt ${attempt}/${retries} failed${isAbort ? ' (timeout)' : ''}: ${err.message}`);
      if (isLast) throw new Error(isAbort ? 'Request timed out. Check your connection and try again.' : err.message);
      await new Promise(r => setTimeout(r, delayMs * attempt));
    }
  }
}


// ═══════════════════════════════════════════════════
// 6. FILE HUB
// ═══════════════════════════════════════════════════
async function loadFiles() {
  try {
    const res = await fetchWithRetry(`${API}/api/files`);
    if (!res.ok) throw new Error('Failed to load files');
    allFiles = await res.json();
    renderFileList(allFiles);
  } catch (err) {
    console.warn('[LoadFiles]', err);
    renderFileList([]);
  }
}

function renderFileList(files) {
  const el = document.getElementById('files-list');
  if (!files.length) {
    el.innerHTML = '<div class="empty-state"><i class="fas fa-folder-plus"></i><p>No files yet. Upload some!</p></div>';
    return;
  }
  el.innerHTML = '';
  files.forEach(f => {
    const item = createFileItem(f);
    el.appendChild(item);
  });
}

function createFileItem(f) {
  const ext = f.original_name.split('.').pop().toLowerCase();
  const isImg = ['jpg','jpeg','png','gif','webp'].includes(ext);
  const isPdf = ext === 'pdf';
  const isVid = ['mp4','webm'].includes(ext);
  const isPpt = ['ppt','pptx'].includes(ext);

  let iconClass, iconType;
  if (isPdf)      { iconClass = 'pdf-icon'; iconType = 'fa-file-pdf'; }
  else if (isImg) { iconClass = 'img-icon'; iconType = 'fa-image'; }
  else if (isVid) { iconClass = 'vid-icon'; iconType = 'fa-file-video'; }
  else if (isPpt) { iconClass = 'ppt-icon'; iconType = 'fa-file-powerpoint'; }
  else            { iconClass = 'img-icon'; iconType = 'fa-file'; }

  const div = document.createElement('div');
  div.className = 'file-item';
  div.dataset.id = f.id;
  div.dataset.name = (f.original_name || '').toLowerCase();
  div.dataset.type = isPdf ? 'pdf' : isImg ? 'image' : isVid ? 'video' : 'other';

  const icon = document.createElement('div');
  icon.className = `file-icon ${iconClass}`;
  icon.innerHTML = `<i class="fas ${iconType}"></i>`;

  const meta = document.createElement('div');
  meta.className = 'file-meta';

  const nameEl = document.createElement('div');
  nameEl.className = 'file-name';
  nameEl.textContent = f.original_name;

  const infoEl = document.createElement('div');
  infoEl.className = 'file-info';
  infoEl.textContent = 'Board ' + parseInt(f.board_id, 10) + (f.subject ? ' · ' + f.subject : '');

  meta.appendChild(nameEl);
  meta.appendChild(infoEl);

  const actions = document.createElement('div');
  actions.className = 'file-actions';

  const openBtn = document.createElement('button');
  openBtn.className = 'file-act-btn open-board-btn';
  openBtn.type = 'button';
  openBtn.title = 'Open on Board';
  openBtn.innerHTML = '<i class="fas fa-external-link-alt"></i>';
  openBtn.onclick = (e) => { e.stopPropagation(); openFileOnBoard(f); };
  actions.appendChild(openBtn);

  const downloadLink = document.createElement('a');
  downloadLink.className = 'file-act-btn';
  downloadLink.title = 'Download File';
  downloadLink.href = '/uploads/' + encodeURIComponent(f.filename);
  downloadLink.setAttribute('download', f.original_name);
  downloadLink.style.display = 'flex';
  downloadLink.style.alignItems = 'center';
  downloadLink.style.justifyContent = 'center';
  downloadLink.style.textDecoration = 'none';
  downloadLink.innerHTML = '<i class="fas fa-download"></i>';
  actions.appendChild(downloadLink);

  if (adminAuthed) {
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'file-act-btn del';
    deleteBtn.type = 'button';
    deleteBtn.title = 'Delete';
    deleteBtn.innerHTML = '<i class="fas fa-trash"></i>';
    deleteBtn.onclick = () => adminDeleteFile(f.id);
    actions.appendChild(deleteBtn);
  }

  div.appendChild(icon);
  div.appendChild(meta);
  div.appendChild(actions);
  return div;
}

function filterFiles(type) {
  const items = document.querySelectorAll('.file-item');
  items.forEach(item => {
    item.style.display = (type === 'all' || item.dataset.type === type) ? '' : 'none';
  });
}

function searchFiles(q) {
  const lower = q.toLowerCase();
  const items = document.querySelectorAll('.file-item');
  items.forEach(item => {
    item.style.display = item.dataset.name.includes(lower) ? '' : 'none';
  });
}

function openFileOnBoard(f) {
  const boardId = f.board_id;
  const subject = f.subject || '';
  const url = '/uploads/' + f.filename;
  
  // Use simple redirect with encoded params
  const target = `board.html?board=${encodeURIComponent(boardId)}&subject=${encodeURIComponent(subject)}&fileUrl=${encodeURIComponent(url)}`;
  window.location.href = target;
}

function triggerFileUpload() {
  if (!authToken && !adminAuthed) { openModal('modal-login'); return; }
  openModal('modal-upload');
}

async function doUserUpload(e) {
  e.preventDefault();
  const input = document.getElementById('user-file-input');
  const files = input.files;
  if (!files.length) return;
  const token = window._adminToken || authToken;
  if (!token) { openModal('modal-login'); return; }
  
  const selectEl = document.getElementById('user-upload-board');
  const boardId = selectEl.value;
  const subject = selectEl.options[selectEl.selectedIndex].dataset.subject || '';

  const fd = new FormData();
  for (const f of files) fd.append('file', f);
  fd.append('board_id', boardId);
  fd.append('subject', subject);
  
  const submitBtn = e.submitter || document.querySelector('#modal-upload button[type="submit"]');
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Uploading…'; }
  
  try {
    const res = await fetchWithRetry(`${API}/api/upload`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token },
      body: fd
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Upload failed (HTTP ${res.status})`);
    loadFiles();
    closeModal('modal-upload');
    showToast(`${data.files?.length || 1} file(s) uploaded!`);
  } catch (err) {
    showToast('Upload failed: ' + err.message, true);
    console.error('[Upload]', err);
  } finally {
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Upload'; }
    input.value = '';
  }
}

// ═══════════════════════════════════════════════════
// 7. BOARD NAVIGATION
// ═══════════════════════════════════════════════════
function openBoard(id) {
  const cfg = boardConfigs[id] || {};
  const params = new URLSearchParams({ board: id, subject: cfg.subject || '' });
  window.location.href = 'board.html?' + params.toString();
}

function openBoardSubject(e, board, subject) {
  e.stopPropagation();
  const params = new URLSearchParams({ board, subject });
  window.location.href = 'board.html?' + params.toString();
}

function configureBoard(e, id) {
  e.stopPropagation();
  if (!authToken && !adminAuthed) {
    showToast('You need to sign in or access admin panel to configure boards', true);
    return;
  }
  document.getElementById('board-config-id').value = id;
  document.getElementById('board-subject-input').value = boardConfigs[id]?.subject || '';
  openModal('modal-configure-board');
}

function doConfigureBoard(e) {
  e.preventDefault();
  const id = document.getElementById('board-config-id').value;
  const subject = document.getElementById('board-subject-input').value.trim();
  boardConfigs[id] = { subject };
  localStorage.setItem('sb_boards', JSON.stringify(boardConfigs));
  closeModal('modal-configure-board');
  applyBoardConfigs();
  showToast('Board 0' + id + ' configured: ' + subject);
}

function applyBoardConfigs() {
  [2,3,4,5].forEach(id => {
    const cfg = boardConfigs[id] || {};
    const nameEl = document.getElementById('board-' + id + '-name');
    const subEl  = document.getElementById('board-' + id + '-sub');
    const card   = document.getElementById('board-card-' + id);
    if (nameEl) nameEl.textContent = 'Board 0' + id;
    if (subEl)  subEl.textContent = cfg.subject || 'Not configured';
    if (card) {
      const btn = card.querySelector('.board-configure-btn');
      if (btn) btn.style.display = cfg.subject ? 'none' : '';
      card.style.cursor = cfg.subject ? 'pointer' : 'default';
    }
  });
}

// ═══════════════════════════════════════════════════
// 8. ANALOG CLOCK
// ═══════════════════════════════════════════════════
function renderClock() {
  const now = new Date();
  const h  = now.getHours() % 12;
  const m  = now.getMinutes();
  const s  = now.getSeconds();

  const hDeg = (h / 12) * 360 + (m / 60) * 30;
  const mDeg = (m / 60) * 360 + (s / 60) * 6;
  const sDeg = (s / 60) * 360;

  const hHand = document.getElementById('hand-hour');
  const mHand = document.getElementById('hand-min');
  const sHand = document.getElementById('hand-sec');
  if (hHand) hHand.setAttribute('transform', `rotate(${hDeg}, 100, 100)`);
  if (mHand) mHand.setAttribute('transform', `rotate(${mDeg}, 100, 100)`);
  if (sHand) sHand.setAttribute('transform', `rotate(${sDeg}, 100, 100)`);

  // Draw tick marks once
  const marksEl = document.getElementById('clock-marks');
  if (marksEl && marksEl.children.length === 0) {
    for (let i = 0; i < 12; i++) {
      const angle = (i / 12) * 2 * Math.PI - Math.PI/2;
      const x1 = 100 + 82 * Math.cos(angle), y1 = 100 + 82 * Math.sin(angle);
      const x2 = 100 + 90 * Math.cos(angle), y2 = 100 + 90 * Math.sin(angle);
      const line = document.createElementNS('http://www.w3.org/2000/svg','line');
      line.setAttribute('x1',x1); line.setAttribute('y1',y1);
      line.setAttribute('x2',x2); line.setAttribute('y2',y2);
      line.setAttribute('stroke','var(--border-2)'); line.setAttribute('stroke-width', i % 3 === 0 ? '2.5' : '1.2');
      marksEl.appendChild(line);
    }
  }

  // Digital time
  const pad = n => String(n).padStart(2,'0');
  const dtEl = document.getElementById('digital-time');
  if (dtEl) dtEl.textContent = `${pad(now.getHours())}:${pad(m)}:${pad(s)}`;

  // Date
  const ddEl = document.getElementById('digital-date');
  if (ddEl) ddEl.textContent = now.toLocaleDateString('en-IN', { weekday:'short', day:'numeric', month:'short', year:'numeric' });
}

// ═══════════════════════════════════════════════════
// 9. CALENDAR
// ═══════════════════════════════════════════════════
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const HOLIDAYS = [
  { m: 0, d: 26, t: 'h', title: 'Republic Day' },
  { m: 2, d: 25, t: 'h', title: 'Holi' },
  { m: 3, d: 11, t: 'h', title: 'Eid-ul-Fitr' },
  { m: 7, d: 15, t: 'h', title: 'Independence Day' },
  { m: 9, d: 2,  t: 'h', title: 'Gandhi Jayanti' },
  { m: 9, d: 31, t: 'h', title: 'Diwali' },
  { m: 11, d: 25, t: 'h', title: 'Christmas' }
];

function renderCalendar() {
  const y = calDate.getFullYear(), m = calDate.getMonth();
  document.getElementById('cal-month-label').textContent = `${MONTHS[m]} ${y}`;

  const grid = document.getElementById('cal-grid');
  grid.innerHTML = '';

  const firstDay = new Date(y, m, 1).getDay();
  const daysInMonth = new Date(y, m+1, 0).getDate();
  const today = new Date();

  // Build reminder index
  const remIdx = {};
  reminders.forEach(r => {
    const d = new Date(r.date);
    if (d.getFullYear() === y && d.getMonth() === m) {
      remIdx[d.getDate()] = r.type;
    }
  });

  // Leading blanks
  for (let i = 0; i < firstDay; i++) {
    const cell = document.createElement('div');
    cell.className = 'cal-day other-month';
    grid.appendChild(cell);
  }

    for (let d = 1; d <= daysInMonth; d++) {
    const cell = document.createElement('div');
    cell.className = 'cal-day';
    cell.textContent = d;
    
    const cellDate = new Date(y, m, d);
    const isSunday = cellDate.getDay() === 0;
    const holiday = HOLIDAYS.find(h => h.m === m && h.d === d);

    if (d === today.getDate() && m === today.getMonth() && y === today.getFullYear()) cell.classList.add('today');
    
    if (isSunday || holiday) {
        cell.classList.add('has-holiday');
        if (holiday) cell.title = holiday.title;
        else cell.title = 'Sunday';
    } else if (remIdx[d]) {
        cell.classList.add('has-' + remIdx[d]);
    }
    
    cell.onclick = () => showDayReminders(y, m, d);
    grid.appendChild(cell);
  }

  renderReminderList(y, m);
}

function renderReminderList(y, m) {
  const el = document.getElementById('reminders-list');
  el.innerHTML = '';
  const filtered = reminders.filter(r => {
    const d = new Date(r.date);
    return d.getFullYear() === y && d.getMonth() === m;
  }).sort((a,b) => new Date(a.date) - new Date(b.date));

  if (!filtered.length) {
    el.innerHTML = '<div style="font-size:11px;color:var(--text-3);padding:4px 0">No events this month</div>';
    return;
  }
  filtered.forEach(r => {
    const div = document.createElement('div');
    div.className = `reminder-item rem-${r.type}`;
    div.innerHTML = `<span class="reminder-dot"></span><span>${escHtml(r.title)}</span><span class="reminder-date">${formatDateShort(r.date)}</span>`;
    el.appendChild(div);
  });
}

function showDayReminders(y, m, d) {
  const dayReminders = reminders.filter(r => {
    const rd = new Date(r.date);
    return rd.getFullYear() === y && rd.getMonth() === m && rd.getDate() === d;
  });
  
  const cellDate = new Date(y, m, d);
  const isSunday = cellDate.getDay() === 0;
  
  let msgLines = dayReminders.map(r => `• ${r.title} (${r.type})`);
  if (isSunday) msgLines.unshift('• Sunday (Holiday)');
  
  if (msgLines.length) {
    alert(`${d} ${MONTHS[m]} ${y}\n\n${msgLines.join('\n')}`);
  }
}

function calPrev() { calDate.setMonth(calDate.getMonth() - 1); renderCalendar(); }
function calNext() { calDate.setMonth(calDate.getMonth() + 1); renderCalendar(); }

function openReminderModal() {
  if (!adminAuthed && !authToken) {
    showToast('Only signed-in users can add holidays and reminders.', true);
    return;
  }
  document.getElementById('rem-date').value = new Date().toISOString().split('T')[0];
  openModal('modal-reminder');
}

function addReminder(e) {
  e.preventDefault();
  const reminder = {
    id: Date.now(),
    title: document.getElementById('rem-title').value.trim(),
    date: document.getElementById('rem-date').value,
    type: document.getElementById('rem-type').value
  };
  reminders.push(reminder);
  localStorage.setItem('sb_reminders', JSON.stringify(reminders));
  closeModal('modal-reminder');
  renderCalendar();
  showToast('Reminder added!');
}

// ═══════════════════════════════════════════════════
// 10. NOTES
// ═══════════════════════════════════════════════════
function loadNotes() {
  const ta = document.getElementById('notes-area');
  if (ta) ta.value = localStorage.getItem('sb_notes') || '';
}
function saveNotes() {
  localStorage.setItem('sb_notes', document.getElementById('notes-area').value);
}
function clearNotes() {
  if (confirm('Clear all notes?')) {
    document.getElementById('notes-area').value = '';
    localStorage.removeItem('sb_notes');
  }
}

// ═══════════════════════════════════════════════════
// 11. SEARCH
// ═══════════════════════════════════════════════════
function setupSearch() {
  const input = document.getElementById('global-search');
  if (!input) return;
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      const q = e.target.value.trim();
      if (q) openSearch('google', q);
    }
  });
}

function openSearch(engine, q) {
  const query = q || document.getElementById('global-search').value.trim() || '';
  const urls = {
    chatgpt: 'https://chat.openai.com' + (query ? `/?q=${encodeURIComponent(query)}` : ''),
    gemini:  'https://gemini.google.com' + (query ? `/?q=${encodeURIComponent(query)}` : ''),
    google:  `https://www.google.com/search?q=${encodeURIComponent(query)}`
  };
  window.open(urls[engine] || urls.google, '_blank');
}

// ═══════════════════════════════════════════════════
// 12. TRANSLATE
// ═══════════════════════════════════════════════════
function swapLangs() {
  const from = document.getElementById('tr-from');
  const to   = document.getElementById('tr-to');
  const tmp = from.value; from.value = to.value; to.value = tmp;
}

async function doTranslate() {
  const text = document.getElementById('tr-input').value.trim();
  if (!text) return;
  const from = document.getElementById('tr-from').value;
  const to   = document.getElementById('tr-to').value;
  const outEl = document.getElementById('tr-output');
  outEl.textContent = 'Translating...';
  outEl.classList.remove('hidden');
  try {
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${from}|${to}`;
    const res = await fetch(url);
    const data = await res.json();
    outEl.textContent = data.responseData?.translatedText || 'Translation failed';
  } catch { outEl.textContent = 'Translation failed. Check connection.'; }
}

// ═══════════════════════════════════════════════════
// 13. SETTINGS ACTIONS
// ═══════════════════════════════════════════════════
function saveLivePreviewSetting(val) {
  livePreviewEnabled = val;
  localStorage.setItem('sb_live_preview', val);
  showToast('Live preview ' + (val ? 'enabled' : 'disabled'));
}

function saveDarkDefault(val) {
  localStorage.setItem('sb_theme', val ? 'dark' : 'light');
}

function changeWallpaper(val) {
  document.body.dataset.wallpaper = val;
  localStorage.setItem('sb_wallpaper', val);
}

function openChangePassword() {
  closeModal('modal-admin');
  openModal('modal-change-pw');
}

async function doChangePassword(e) {
  e.preventDefault();
  const current = document.getElementById('cp-current').value;
  const newPw   = document.getElementById('cp-new').value;
  const errEl   = document.getElementById('cp-error');
  errEl.classList.add('hidden');
  try {
    const res = await fetch(`${API}/api/admin/password`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + window._adminToken },
      body: JSON.stringify({ currentPassword: current, newPassword: newPw })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed');
    closeModal('modal-change-pw');
    showToast('Admin password updated!');
  } catch (err) { errEl.textContent = err.message; errEl.classList.remove('hidden'); }
}

// ═══════════════════════════════════════════════════
// 14. CLASS ROUTINE
// ═══════════════════════════════════════════════════
function openRoutineModal() {
  const routineFile = allFiles.find(f => f.subject === 'ROUTINE');
  if (routineFile) {
    window.open('/uploads/' + routineFile.filename, '_blank');
  } else {
    showToast('Class routine not set. Admin can upload via File Hub.');
  }
}

// ═══════════════════════════════════════════════════
// 15. DRAG & DROP ON HOME
// ═══════════════════════════════════════════════════
function setupDragDrop() {
  const body = document.body;
  body.addEventListener('dragover', e => e.preventDefault());
  body.addEventListener('drop', e => {
    e.preventDefault();
    const files = e.dataTransfer.files;
    if (files.length) triggerFileUpload();
  });
}

// ═══════════════════════════════════════════════════
// 16. MODAL HELPERS
// ═══════════════════════════════════════════════════
function openModal(id) {
  const el = document.getElementById(id);
  if (el) { el.classList.remove('hidden'); }
}
function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.add('hidden');
}
function setupModalOverlayClose() {
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', e => {
      if (e.target === overlay) overlay.classList.add('hidden');
    });
  });
}

// ═══════════════════════════════════════════════════
// 17. TOAST & NOTIFICATION
// ═══════════════════════════════════════════════════
function showToast(msg, isError = false) {
  const el = document.getElementById('toast');
  const msgEl = document.getElementById('toast-msg');
  if (!el || !msgEl) return;
  msgEl.textContent = msg;
  el.className = 'toast' + (isError ? ' error' : '');
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3000);
}

function showNotif(msg) {
  const el = document.getElementById('notif-badge');
  const msgEl = document.getElementById('notif-msg');
  if (!el || !msgEl) return;
  msgEl.textContent = msg;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 6000);
}

// ═══════════════════════════════════════════════════
// 18. HELPERS
// ═══════════════════════════════════════════════════
function togglePw(id, btn) {
  const inp = document.getElementById(id);
  if (!inp) return;
  inp.type = inp.type === 'password' ? 'text' : 'password';
  btn.querySelector('i').className = inp.type === 'password' ? 'fas fa-eye' : 'fas fa-eye-slash';
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function formatDate(str) {
  if (!str) return '';
  try { return new Date(str).toLocaleDateString('en-IN', { day:'numeric', month:'short', year:'numeric' }); }
  catch { return str; }
}

function formatDateShort(str) {
  if (!str) return '';
  try {
    const d = new Date(str);
    return `${d.getDate()} ${MONTHS[d.getMonth()].slice(0,3)}`;
  } catch { return str; }
}

// Apply saved wallpaper
window.addEventListener('DOMContentLoaded', () => {
  const wp = localStorage.getItem('sb_wallpaper');
  if (wp) { document.body.dataset.wallpaper = wp; const sel = document.getElementById('wallpaper-select'); if (sel) sel.value = wp; }
});
