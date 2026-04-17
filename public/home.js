/* ═══════════════════════════════════════════════════════════════
   SMARTBOARD — HOME.JS
   Dashboard logic: auth, files, calendar, clock, widgets
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const API = '';  // same-origin

// ═══════════════════════════════════════════════════
// 1. STATE
// ═══════════════════════════════════════════════════
let authToken   = localStorage.getItem('sb_token') || null;
let currentUser = JSON.parse(localStorage.getItem('sb_user') || 'null');
let adminAuthed = false;
let allFiles    = [];
let reminders   = JSON.parse(localStorage.getItem('sb_reminders') || '[]');
let boardConfigs= JSON.parse(localStorage.getItem('sb_boards') || '{}');
let calDate     = new Date();
let toastTimer  = null;
let livePreviewEnabled = localStorage.getItem('sb_live_preview') !== 'false';

// ═══════════════════════════════════════════════════
// 2. INIT
// ═══════════════════════════════════════════════════
window.addEventListener('DOMContentLoaded', () => {
  applyTheme(localStorage.getItem('sb_theme') || 'dark');
  applyBoardConfigs();
  updateNavUser();
  renderClock();
  renderCalendar();
  loadFiles();
  loadNotes();
  setupSearch();
  setupDragDrop();
  setupModalOverlayClose();
  setInterval(renderClock, 1000);
  if (authToken) loadFiles();
});

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
      authToken = null; currentUser = null;
      localStorage.removeItem('sb_token');
      localStorage.removeItem('sb_user');
      updateNavUser();
      showToast('Signed out');
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
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Login failed');

    authToken = data.token; currentUser = data.user;
    localStorage.setItem('sb_token', authToken);
    localStorage.setItem('sb_user', JSON.stringify(currentUser));
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
      body: JSON.stringify({ username, password })
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
    const res = await fetch(`${API}/api/admin/users`, {
      headers: { 'Authorization': 'Bearer ' + window._adminToken }
    });
    const users = await res.json();
    if (!users.length) { el.innerHTML = '<div class="empty-admin">No users yet. Create one!</div>'; return; }
    el.innerHTML = '';
    users.forEach(u => {
      const item = document.createElement('div');
      item.className = 'admin-list-item';
      item.innerHTML = `
        <div class="alist-icon" style="background:var(--accent-glow);color:var(--accent-2);"><i class="fas fa-user"></i></div>
        <div>
          <div class="alist-name">${escHtml(u.username)}</div>
          <div class="alist-meta">ID: ${u.id}</div>
        </div>
        <div class="alist-actions">
          <button class="alist-btn danger" onclick="deleteUser(${u.id})"><i class="fas fa-trash"></i> Delete</button>
        </div>`;
      el.appendChild(item);
    });
    document.getElementById('stat-users').textContent = users.length;
  } catch { el.innerHTML = '<div class="empty-admin" style="color:var(--danger)">Failed to load users</div>'; }
}

async function loadAdminFiles() {
  const el = document.getElementById('admin-files-list');
  el.innerHTML = '<div style="color:var(--text-2);font-size:12px;padding:10px">Loading...</div>';
  try {
    const res = await fetch(`${API}/api/admin/files`, {
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
      item.innerHTML = `
        <div class="alist-icon" style="font-size:18px">${icon}</div>
        <div>
          <div class="alist-name">${escHtml(f.original_name)}</div>
          <div class="alist-meta">Board ${f.board_id}${f.subject ? ' · ' + f.subject : ''} · ${formatDate(f.uploaded_at)}</div>
        </div>
        <div class="alist-actions">
          <button class="alist-btn" onclick="window.open('/uploads/${escHtml(f.filename)}','_blank')"><i class="fas fa-eye"></i></button>
          <button class="alist-btn danger" onclick="adminDeleteFile(${f.id})"><i class="fas fa-trash"></i></button>
        </div>`;
      el.appendChild(item);
    });
    document.getElementById('stat-files').textContent = files.length;
  } catch { el.innerHTML = '<div style="color:var(--danger)">Failed to load files</div>'; }
}

async function loadAdminBoards() {
  const el = document.getElementById('admin-boards-list');
  el.innerHTML = '<div style="color:var(--text-2);font-size:12px;padding:10px">Checking statuses...</div>';
  
  let statuses = {};
  try {
      const sres = await fetch(`${API}/api/admin/board-status`, { headers: { 'Authorization': 'Bearer ' + window._adminToken } });
      statuses = await sres.json();
  } catch(e) {}

  el.innerHTML = '';
  [1,2,3,4,5].forEach(id => {
    const cfg = boardConfigs[id] || {};
    const s = statuses[id] || { isActive: false };
    const liveColor = s.isActive ? '#10b981' : '#6b7280'; // Green if active, Gray otherwise
    const item = document.createElement('div');
    item.className = 'admin-list-item';
    item.innerHTML = `
      <div class="alist-icon" style="background:var(--accent-glow);color:var(--accent-2);font-weight:800;font-size:14px">
        ${id}
        ${s.isActive ? '<div style="position:absolute;top:-2px;right:-2px;width:10px;height:10px;background:#10b981;border-radius:50%;border:2px solid var(--bg-1)"></div>' : ''}
      </div>
      <div>
        <div class="alist-name">Board 0${id}</div>
        <div class="alist-meta">${id === 1 ? (cfg.subject || 'Core Subjects') : (cfg.subject || 'Not configured')}</div>
      </div>
      <div class="alist-actions" style="gap:5px;">
        <button class="alist-btn" onclick="openBoardLive(${id})" style="background:${liveColor}; color:white; border:none;" title="Live Preview" ${!s.isActive ? 'disabled' : ''}><i class="fas fa-satellite-dish"></i> Live</button>
        <button class="alist-btn" onclick="openBoard(${id})"><i class="fas fa-eye"></i> View</button>
        <button class="alist-btn" onclick="triggerAdminRoutineUploadBoard(${id})" style="background:#f59e0b; color:white; border:none;" title="Upload Routine"><i class="fas fa-calendar-plus"></i> Routine</button>
        <button class="alist-btn" onclick="adminConfigBoard(${id})"><i class="fas fa-edit"></i> Edit</button>
        <button class="alist-btn danger" onclick="adminClearBoard(${id})"><i class="fas fa-ban"></i> Clear</button>
      </div>`;
    el.appendChild(item);
  });
}


function openBoardLive(id) {
  const params = new URLSearchParams({ board: id, live: 'true' });
  window.open('board.html?' + params.toString(), '_blank');
}

async function loadAnalytics() {
  try {
    const [filesRes, usersRes] = await Promise.all([
      fetch(`${API}/api/admin/files`, { headers: { 'Authorization': 'Bearer ' + window._adminToken } }),
      fetch(`${API}/api/admin/users`, { headers: { 'Authorization': 'Bearer ' + window._adminToken } })
    ]);
    const files = await filesRes.json();
    const users = await usersRes.json();
    document.getElementById('stat-files').textContent = files.length;
    document.getElementById('stat-users').textContent = users.length;

    const recent = document.getElementById('recent-activity');
    recent.innerHTML = '';
    files.slice(0,5).reverse().forEach(f => {
      const item = document.createElement('div');
      item.className = 'recent-item';
      item.innerHTML = `<span class="recent-icon">📁</span><span>Uploaded: ${escHtml(f.original_name)}</span><span class="recent-time">${formatDate(f.uploaded_at)}</span>`;
      recent.appendChild(item);
    });
  } catch {}
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

  try {
    const res = await fetch(`${API}/api/upload`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + window._adminToken },
      body: fd
    });
    if (!res.ok) throw new Error('Upload failed');
    loadAdminFiles();
    loadFiles();
    showToast('Routine for Board ' + (boardId === 0 ? 'Global' : '0'+boardId) + ' updated!');
  } catch (err) { showToast('Routine upload failed: ' + err.message, true); }
  input.value = '';
}

async function doAdminUpload(input) {
  const files = input.files;
  if (!files.length) return;
  const selectEl = document.getElementById('admin-upload-board');
  const boardId = selectEl.value;
  const subject = selectEl.options[selectEl.selectedIndex].dataset.subject || '';

  const fd = new FormData();
  for (const f of files) fd.append('file', f);
  fd.append('board_id', boardId);
  fd.append('subject', subject);

  try {
    const res = await fetch(`${API}/api/upload`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + window._adminToken },
      body: fd
    });
    if (!res.ok) throw new Error('Upload failed');
    loadAdminFiles();
    loadFiles();
    showNotif('New file uploaded by admin!');
    showToast('File(s) uploaded successfully');
  } catch (err) { showToast('Upload failed: ' + err.message, true); }
  input.value = '';
}

// ═══════════════════════════════════════════════════
// 6. FILE HUB
// ═══════════════════════════════════════════════════
async function loadFiles() {
  try {
    const res = await fetch(`${API}/api/files`);
    allFiles = await res.json();
    renderFileList(allFiles);
  } catch { renderFileList([]); }
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
  div.dataset.name = f.original_name.toLowerCase();
  div.dataset.type = isPdf ? 'pdf' : isImg ? 'image' : isVid ? 'video' : 'other';

  div.innerHTML = `
    <div class="file-icon ${iconClass}"><i class="fas ${iconType}"></i></div>
    <div class="file-meta">
      <div class="file-name">${escHtml(f.original_name)}</div>
      <div class="file-info">Board ${parseInt(f.board_id)}${f.subject ? ' · ' + escHtml(f.subject) : ''}</div>
    </div>
    <div class="file-actions">
      <button class="file-act-btn open-board-btn" title="Open on Board"><i class="fas fa-external-link-alt"></i></button>
      <a class="file-act-btn" title="Download File" href="/uploads/${f.filename}" download="${f.original_name}" style="display:flex; align-items:center; justify-content:center; text-decoration:none;"><i class="fas fa-download"></i></a>
      ${adminAuthed ? `<button class="file-act-btn del" title="Delete" onclick="adminDeleteFile(${f.id})"><i class="fas fa-trash"></i></button>` : ''}
    </div>`;
    
  div.querySelector('.open-board-btn').onclick = (e) => {
    e.stopPropagation();
    openFileOnBoard(f);
  };
  
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
  
  try {
    const res = await fetch(`${API}/api/upload`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token },
      body: fd
    });
    if (!res.ok) throw new Error('Upload failed');
    loadFiles();
    closeModal('modal-upload');
    showToast('File(s) uploaded!');
  } catch (err) { showToast(err.message, true); }
  input.value = '';
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
