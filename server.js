/* ═══════════════════════════════════════════════════════════════
   SMARTBOARD — server.js
   Express backend: auth, admin, file upload, boards
   ═══════════════════════════════════════════════════════════════ */
'use strict';

const express  = require('express');
const Database = require('better-sqlite3');
const multer   = require('multer');
const bcrypt   = require('bcrypt');
const jwt      = require('jsonwebtoken');
const cors     = require('cors');
const path     = require('path');
const fs       = require('fs');
const helmet   = require('helmet');
const rateLimit= require('express-rate-limit');


const app = express();
const httpServer = require('http').createServer(app);
const io = require('socket.io')(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(helmet({
  contentSecurityPolicy: false, // Allow CDNs for PDF.js and FontAwesome
  crossOriginResourcePolicy: false
}));
app.use(express.json({ limit: '10kb' })); // Limit body size
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));


// ── Storage Configuration (Render Persistent Disk Support) ─────────
const DATA_DIR = fs.existsSync('/app/data') ? '/app/data' : path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch(e) {}
}

let uploadDir = path.join(DATA_DIR, 'uploads');
try {
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    // Verify writability
    fs.accessSync(uploadDir, fs.constants.W_OK);
} catch (e) {
    console.warn("⚠️ Primary upload dir unusable, switching to /tmp/uploads");
    uploadDir = path.join('/tmp', 'uploads');
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
}

app.use('/uploads', express.static(uploadDir, {
  setHeaders: (res, path) => {
    res.set('Content-Disposition', 'inline'); 
  }
}));

// Rate Limiter for sensitive actions (Relaxed for college projects and batch uploads)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200, 
  message: { error: "Security limit reached. Please wait a few minutes before trying again." }
});


// ── Database ──────────────────────────────────────
const dbPath = path.join(DATA_DIR, 'database.sqlite');
let db;
try {
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
} catch (err) {
    console.error("📂 SQLite CantOpen at", dbPath, "-", err.message);
    const fallbackPath = path.join('/tmp', 'database.sqlite');
    console.log("⚠️ Emergency fallback to:", fallbackPath);
    db = new Database(fallbackPath);
}

const SECRET_KEY       = process.env.JWT_SECRET       || 'sb_jwt_secret_2024_!@#xK9';
const ADMIN_SECRET_KEY = process.env.ADMIN_JWT_SECRET || 'sb_admin_jwt_2024_$%^yL8';

// ══════════════════════════════════════════════════
// DATABASE SCHEMA INITIALIZATION
// ══════════════════════════════════════════════════

// Ensure base tables exist
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    username   TEXT UNIQUE,
    email      TEXT UNIQUE,
    password   TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS files (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    filename      TEXT NOT NULL,
    original_name TEXT NOT NULL,
    file_type     TEXT DEFAULT 'pdf',
    board_id      INTEGER DEFAULT 1,
    subject       TEXT DEFAULT '',
    uploaded_at   TEXT DEFAULT (datetime('now'))
  );
`);

// Safe migrations for older DBs (adding columns if missing)
const migrateDb = () => {
  const getCols = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  
  // Users table
  const userCols = getCols('users');
  if (!userCols.includes('email')) db.exec(`ALTER TABLE users ADD COLUMN email TEXT`);
  if (!userCols.includes('username')) db.exec(`ALTER TABLE users ADD COLUMN username TEXT`);
  if (!userCols.includes('created_at')) {
    db.exec(`ALTER TABLE users ADD COLUMN created_at TEXT`);
    db.exec(`UPDATE users SET created_at = datetime('now') WHERE created_at IS NULL`);
  }
  
  // Files table
  const fileCols = getCols('files');
  if (!fileCols.includes('file_type')) db.exec(`ALTER TABLE files ADD COLUMN file_type TEXT DEFAULT 'pdf'`);
  if (!fileCols.includes('board_id')) db.exec(`ALTER TABLE files ADD COLUMN board_id INTEGER DEFAULT 1`);
  if (!fileCols.includes('subject')) db.exec(`ALTER TABLE files ADD COLUMN subject TEXT DEFAULT ''`);
  if (!fileCols.includes('uploaded_at')) {
    db.exec(`ALTER TABLE files ADD COLUMN uploaded_at TEXT`);
    db.exec(`UPDATE files SET uploaded_at = datetime('now') WHERE uploaded_at IS NULL`);
  }

  try {
    db.exec(`UPDATE users SET username = email WHERE (username IS NULL OR username = '') AND email IS NOT NULL`);
    db.exec(`UPDATE users SET email = username WHERE (email IS NULL OR email = '') AND username IS NOT NULL`);
    const cols = db.prepare(`PRAGMA table_info(admin_settings)`).all().map(c => c.name);
    if (cols.includes('username_hash')) db.exec(`DROP TABLE admin_settings`);
  } catch(e) {}
};
migrateDb();

// Re-create Admin settings if missing (independent table)
db.exec(`
  CREATE TABLE IF NOT EXISTS admin_settings (
    id            INTEGER PRIMARY KEY CHECK (id = 1),
    username      TEXT NOT NULL,
    password_hash TEXT NOT NULL
  );
`);

// ══════════════════════════════════════════════════
// SEED ADMIN CREDENTIALS (first run only)
// Admin: Gaurav / gk07011019
// Credentials are hashed — never stored as plain text
// ══════════════════════════════════════════════════
(async () => {
  try {
    const passwordHash = await bcrypt.hash('gk07011019', 12);
    // Use REPLACE to ensure latest credentials are always active on deploy
    db.prepare('REPLACE INTO admin_settings (id, username, password_hash) VALUES (1, ?, ?)').run('Gaurav', passwordHash);
    console.log('✅ Admin credentials initialized/updated');
  } catch(e) { console.error("Admin seed failed:", e.message); }
})();

// ══════════════════════════════════════════════════
// FILE STORAGE
// ══════════════════════════════════════════════════
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename:    (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, Date.now() + '-' + safe);
  }
});

const fileFilter = (req, file, cb) => {
  const allowed = /\.(pdf|jpg|jpeg|png|gif|webp|mp4|webm|ppt|pptx)$/i;
  if (allowed.test(file.originalname)) cb(null, true);
  else cb(new Error('File type not allowed'));
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 500 * 1024 * 1024 } // Increased to 500 MB for large college projects
});

// ══════════════════════════════════════════════════
// MIDDLEWARE
// ══════════════════════════════════════════════════
const authenticate = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized — login required' });
  try {
    req.user = jwt.verify(token, SECRET_KEY);
    next();
  } catch {
    res.status(403).json({ error: 'Invalid or expired token' });
  }
};

const authenticateAdmin = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Admin access required' });
  try {
    const payload = jwt.verify(token, ADMIN_SECRET_KEY);
    if (payload.role !== 'admin') throw new Error('Not admin');
    req.admin = payload;
    next();
  } catch {
    res.status(403).json({ error: 'Admin authentication failed' });
  }
};

// ══════════════════════════════════════════════════
// PREPARED STATEMENTS
// ══════════════════════════════════════════════════
const stmts = {
  insertUser:    db.prepare('INSERT INTO users (username, email, password) VALUES (?, ?, ?)'),
  getUserByName: db.prepare('SELECT * FROM users WHERE username = ? OR email = ?'),
  getAllUsers:   db.prepare('SELECT id, COALESCE(username, email) as username, created_at FROM users'),
  deleteUser:    db.prepare('DELETE FROM users WHERE id = ?'),
  insertFile:    db.prepare('INSERT INTO files (filename, original_name, file_type, board_id, subject) VALUES (?, ?, ?, ?, ?)'),
  getAllFiles:   db.prepare('SELECT * FROM files ORDER BY uploaded_at DESC'),
  getFileById:   db.prepare('SELECT * FROM files WHERE id = ?'),
  deleteFile:    db.prepare('DELETE FROM files WHERE id = ?'),
  getAdminCreds: db.prepare('SELECT * FROM admin_settings WHERE id = 1'),
  updateAdminPw: db.prepare('UPDATE admin_settings SET password_hash = ? WHERE id = 1'),
};

// ══════════════════════════════════════════════════
// USER ROUTES
// ══════════════════════════════════════════════════

// POST /api/login — user login
app.post('/api/login', authLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    const user = stmts.getUserByName.get(username, username);
    if (!user) return res.status(400).json({ error: 'User not found. Ask admin to create your account.' });
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: 'Incorrect password' });
    const displayName = user.username || user.email || username;
    const token = jwt.sign({ id: user.id, username: displayName }, SECRET_KEY, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, username: displayName } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/files — list all public files (no auth needed for listing)
app.get('/api/files', (req, res) => {
  try {
    res.json(stmts.getAllFiles.all() || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/board-files
app.get('/api/board-files', (req, res) => {
  try {
    let { board = '1', subject = '' } = req.query;
    board = parseInt(board);
    if (isNaN(board)) board = 1;
    subject = String(subject).slice(0, 50); // Limit length

    
    // Proper Filtering: Only show files related to the selected subject OR global routines
    let query, params;
    
    if (subject) {
        // Filter by specific subject (case-insensitive) OR board/global routines
        query = `
            SELECT * FROM files 
            WHERE (board_id = ? AND (LOWER(subject) = LOWER(?) OR LOWER(subject) = 'routine'))
               OR (board_id = 0 AND LOWER(subject) = 'routine')
        `;
        params = [+board, subject];
    } else {
        // Fallback: Show all for this board + routines if no specific subject requested
        query = `
            SELECT * FROM files 
            WHERE board_id = ? 
               OR (board_id = 0 AND LOWER(subject) = 'routine')
        `;
        params = [+board];
    }

    query += ' ORDER BY uploaded_at DESC';
    const files = db.prepare(query).all(...params);
    res.json(files || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/board-status — Get active status of all boards
app.get('/api/admin/board-status', authenticateAdmin, (req, res) => {
    const statuses = {};
    for (let id of [1,2,3,4,5]) {
        const last = boardActivity[id] || 0;
        const isActive = (Date.now() - last) < 30000; // Active if stroke in last 30s
        statuses[id] = { isActive, lastActivity: last };
    }
    res.json(statuses);
});

// POST /api/upload — upload file (auth required)
app.post('/api/upload', authLimiter, authenticate, upload.array('file', 20), (req, res) => {
  try {
    if (!req.files || !req.files.length) return res.status(400).json({ error: 'No files provided' });
    let { board_id = 1, subject = '' } = req.body;
    board_id = parseInt(board_id);
    if (isNaN(board_id)) board_id = 1;
    subject = String(subject).slice(0, 50);

    const inserted = [];
    req.files.forEach(f => {
      const ext = path.extname(f.originalname).slice(1).toLowerCase();
      const fileType = ['pdf'].includes(ext) ? 'pdf' : ['mp4','webm'].includes(ext) ? 'video' : ['ppt','pptx'].includes(ext) ? 'ppt' : 'image';
      const result = stmts.insertFile.run(f.filename, f.originalname, fileType, +board_id, subject);
      inserted.push({ id: result.lastInsertRowid, filename: f.filename, original_name: f.originalname, file_type: fileType });
    });
    res.json({ files: inserted, message: 'Upload successful' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/files/:id — delete file (admin auth required)
app.delete('/api/files/:id', authenticateAdmin, (req, res) => {
  try {
    const f = stmts.getFileById.get(req.params.id);
    if (!f) return res.status(404).json({ error: 'File not found' });
    const fp = path.join(uploadDir, f.filename);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
    stmts.deleteFile.run(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════
// ADMIN ROUTES (all protected by admin JWT)
// ══════════════════════════════════════════════════

// POST /api/admin/login — admin login (credentials verified against hashed values)
app.post('/api/admin/login', authLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Credentials required' });
    const creds = stmts.getAdminCreds.get();
    if (!creds) return res.status(500).json({ error: 'Admin not configured' });
    
    // Case-insensitive username check
    if (username.toLowerCase() !== creds.username.toLowerCase()) {
      return res.status(401).json({ error: 'Invalid admin credentials' });
    }
    
    const passwordMatch = await bcrypt.compare(password, creds.password_hash);
    if (!passwordMatch) {
      return res.status(401).json({ error: 'Invalid admin credentials' });
    }
    const token = jwt.sign({ role: 'admin', username: creds.username }, ADMIN_SECRET_KEY, { expiresIn: '4h' });
    res.json({ token, username: creds.username });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/users — list all users
app.get('/api/admin/users', authenticateAdmin, (req, res) => {
  try {
    res.json(stmts.getAllUsers.all() || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/users — create a new user
app.post('/api/admin/users', authenticateAdmin, async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    if (username.length < 3) return res.status(400).json({ error: 'Username too short (min 3 chars)' });
    if (password.length < 6) return res.status(400).json({ error: 'Password too short (min 6 chars)' });
    const hash = await bcrypt.hash(password, 10);
    const result = stmts.insertUser.run(username, username, hash); // username, email (same), password
    res.json({ id: result.lastInsertRowid, username });
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(400).json({ error: 'Username already exists' });
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/admin/users/:id — delete a user
app.delete('/api/admin/users/:id', authenticateAdmin, (req, res) => {
  try {
    stmts.deleteUser.run(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/files — list all files (admin view)
app.get('/api/admin/files', authenticateAdmin, (req, res) => {
  try {
    res.json(stmts.getAllFiles.all() || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/admin/password — change admin password
app.put('/api/admin/password', authenticateAdmin, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both passwords required' });
    if (newPassword.length < 8) return res.status(400).json({ error: 'New password too short (min 8 chars)' });
    const creds = stmts.getAdminCreds.get();
    const match = await bcrypt.compare(currentPassword, creds.password_hash);
    if (!match) return res.status(401).json({ error: 'Current password incorrect' });
    const newHash = await bcrypt.hash(newPassword, 12);
    stmts.updateAdminPw.run(newHash);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/active-users — simulated active user count
app.get('/api/admin/active-users', authenticateAdmin, (req, res) => {
  res.json({ count: Math.floor(Math.random() * 5) + 1 });
});

// ══════════════════════════════════════════════════
// LEGACY ROUTES (for backward compatibility)
// ══════════════════════════════════════════════════
app.post('/api/register', async (req, res) => {
  res.status(403).json({ error: 'Self-registration disabled. Contact admin to create an account.' });
});

// SERVE FRONTEND — catch-all
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ══════════════════════════════════════════════════
// START SERVER
// ══════════════════════════════════════════════════
// ══════════════════════════════════════════════════
// SOCKET.IO: REAL-TIME SYNC
// ══════════════════════════════════════════════════
const boardStates = {}; 
const boardActivity = {}; 

io.on('connection', (socket) => {
    socket.on('join-board', (boardId) => {
        socket.join(`board-${boardId}`);
    });

    socket.on('join-admin', (boardId) => {
        socket.join(`admin-board-${boardId}`);
        // Send current state to admin joining
        if (boardStates[boardId]) {
            socket.emit('init-strokes', boardStates[boardId]);
        }
    });

    socket.on('draw-stroke', (data) => {
        const { boardId, stroke } = data;
        if (!boardStates[boardId]) boardStates[boardId] = [];
        boardStates[boardId].push(stroke);
        boardActivity[boardId] = Date.now();
        socket.to(`admin-board-${boardId}`).emit('draw-stroke', stroke);
    });

    socket.on('sync-background', (data) => {
        const boardId = data.board;
        boardActivity[boardId] = Date.now();
        socket.to(`admin-board-${boardId}`).emit('sync-background', data);
    });

    socket.on('clear-board', (boardId) => {
        boardStates[boardId] = [];
        boardActivity[boardId] = Date.now();
        socket.to(`admin-board-${boardId}`).emit('clear-board');
    });

    socket.on('disconnect', () => { });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`\n🚀 SmartBoard with Real-Time Sync running at http://localhost:${PORT}`);
  console.log(`   Home     → http://localhost:${PORT}/`);
  console.log(`   Board    → http://localhost:${PORT}/board.html`);
  console.log(`   Admin    → Settings icon on home screen (Admin panel)\n`);
});
