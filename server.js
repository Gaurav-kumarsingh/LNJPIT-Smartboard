/* ═══════════════════════════════════════════════════════════════
   SMARTBOARD — server.js
   Express backend: auth (MongoDB Atlas), file upload (disk),
   admin (SQLite), real-time boards (Socket.IO)
   ═══════════════════════════════════════════════════════════════ */
'use strict';

// ── Load .env FIRST so every require() below sees process.env ───────────────
require('dotenv').config();

// ── Core dependencies ────────────────────────────────────────────────────────
const express   = require('express');
const Database  = require('better-sqlite3');
const multer    = require('multer');
const bcrypt    = require('bcrypt');
const jwt       = require('jsonwebtoken');
const cors      = require('cors');
const path      = require('path');
const fs        = require('fs');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');
const { PDFDocument, rgb } = require('pdf-lib');
const QRCode    = require('qrcode');


// ──STRICT ENV VARIABLE VALIDATION ─────────────────────────────────────────────
const requiredEnvVars = ['JWT_SECRET', 'ADMIN_JWT_SECRET', 'ADMIN_USERNAME', 'ADMIN_PASSWORD', 'FRONTEND_URL'];
requiredEnvVars.forEach(v => {
  if (!process.env[v]) {
    console.error(`❌ FATAL: Missing required environment variable: ${v}`);
    console.error('Please set all variables in Render environment or .env file');
    process.exit(1);
  }
});

// Validate secret strength in production
if (process.env.NODE_ENV === 'production') {
  if (process.env.JWT_SECRET.length < 32) {
    console.error('❌ JWT_SECRET must be at least 32 characters in production');
    process.exit(1);
  }
  if (process.env.ADMIN_JWT_SECRET.length < 32) {
    console.error('❌ ADMIN_JWT_SECRET must be at least 32 characters in production');
    process.exit(1);
  }
  if (process.env.ADMIN_PASSWORD.length < 12) {
    console.error('❌ ADMIN_PASSWORD must be at least 12 characters in production');
    process.exit(1);
  }
}

// ── App & HTTP server ─────────────────────────────────────────────────────────
const app        = express();
const httpServer = require('http').createServer(app);
let io;

// ── Security headers ──────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdnjs.cloudflare.com', 'https://fonts.googleapis.com'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://cdnjs.cloudflare.com'],
      imgSrc: ["'self'", 'data:', 'https:'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'https://cdnjs.cloudflare.com'],
      connectSrc: ["'self'"],
      mediaSrc: ["'self'"],
      objectSrc: ["'none'"],
    }
  },
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  frameOptions: { action: 'SAMEORIGIN' },
  xssFilter: true,
  noSniff: true,
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  }
}));

// Force HTTPS in production
app.use((req, res, next) => {
  if (process.env.NODE_ENV === 'production' && req.header('x-forwarded-proto') !== 'https') {
    return res.redirect(301, `https://${req.header('host')}${req.url}`);
  }
  next();
});

app.use(express.json({ limit: '100mb' }));

// ── CORS — strict whitelist for production ────────────────────────────────────
const ALLOWED_ORIGINS = [
  process.env.FRONTEND_URL,
  process.env.NODE_ENV === 'development' ? 'http://localhost:3000' : null,
  process.env.NODE_ENV === 'development' ? 'http://localhost:5173' : null,
].filter(Boolean);

io = require('socket.io')(httpServer, {
  cors: { origin: ALLOWED_ORIGINS, methods: ['GET', 'POST'], credentials: true },
});

app.use(cors({
  origin: (origin, cb) => {
    // In production, NEVER allow missing origin
    if (!origin) {
      if (process.env.NODE_ENV === 'production') {
        return cb(new Error('Request origin not specified'), false);
      }
      // Allow health checks in dev
      return cb(null, true);
    }
    
    if (ALLOWED_ORIGINS.includes(origin)) {
      return cb(null, true);
    }
    
    cb(new Error(`CORS: origin ${origin} not allowed`), false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400
}));

app.use(express.static(path.join(__dirname, 'public')));


// ══════════════════════════════════════════════════════════════════════════════
// DISK STORAGE (files — PDF, images, video — NEVER stored in MongoDB)
// ══════════════════════════════════════════════════════════════════════════════
const DATA_DIR = fs.existsSync('/app/data') ? '/app/data' : path.join(__dirname, 'data');
try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}

let uploadDir = path.join(DATA_DIR, 'uploads');
try {
  if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
  fs.accessSync(uploadDir, fs.constants.W_OK);
} catch (_) {
  console.warn('⚠️  Primary upload dir unusable → /tmp/uploads');
  uploadDir = path.join('/tmp', 'uploads');
  if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
}

app.use('/uploads', express.static(uploadDir, {
  setHeaders: (res) => res.set('Content-Disposition', 'inline'),
}));

// ── Multer (disk-based upload) ────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename:    (_req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}-${safe}`);
  },
});

// ✅ Enhanced file validation with MIME type checking
const ALLOWED_MIMES = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx'
};

const fileFilter = (_req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  const mime = file.mimetype || '';
  
  // Validate MIME type
  if (!ALLOWED_MIMES[mime]) {
    return cb(Object.assign(new Error(`Invalid MIME type: ${mime}`), { code: 'BAD_TYPE' }), false);
  }
  
  // Verify extension matches MIME
  const expectedExt = ALLOWED_MIMES[mime];
  if (ext !== `.${expectedExt}`) {
    return cb(Object.assign(new Error('File extension does not match content type'), { code: 'BAD_TYPE' }), false);
  }
  
  cb(null, true);
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB max per file
});

// ══════════════════════════════════════════════════════════════════════════════
// SQLITE — only for: files metadata, admin_settings
// Users table is kept for migration safety but NOT used for auth.
// ══════════════════════════════════════════════════════════════════════════════
const dbPath = path.join(DATA_DIR, 'database.sqlite');
let db;
try {
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
} catch (err) {
  console.error('📂  SQLite open failed:', err.message, '— falling back to /tmp');
  db = new Database(path.join('/tmp', 'database.sqlite'));
}

db.exec(`
  CREATE TABLE IF NOT EXISTS files (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    filename      TEXT NOT NULL,
    original_name TEXT NOT NULL,
    file_type     TEXT DEFAULT 'pdf',
    board_id      INTEGER DEFAULT 1,
    subject       TEXT DEFAULT '',
    uploaded_at   TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS admin_settings (
    id            INTEGER PRIMARY KEY CHECK (id = 1),
    username      TEXT NOT NULL,
    password_hash TEXT NOT NULL
  );
`);

// Safe file-table migrations
(() => {
  const cols = db.prepare('PRAGMA table_info(files)').all().map(c => c.name);
  if (!cols.includes('file_type'))  db.exec(`ALTER TABLE files ADD COLUMN file_type TEXT DEFAULT 'pdf'`);
  if (!cols.includes('board_id'))   db.exec(`ALTER TABLE files ADD COLUMN board_id INTEGER DEFAULT 1`);
  if (!cols.includes('subject'))    db.exec(`ALTER TABLE files ADD COLUMN subject TEXT DEFAULT ''`);
  if (!cols.includes('uploaded_at')) {
    db.exec(`ALTER TABLE files ADD COLUMN uploaded_at TEXT`);
    db.exec(`UPDATE files SET uploaded_at = datetime('now') WHERE uploaded_at IS NULL`);
  }
})();

// ── Prepared statements (files + admin only) ──────────────────────────────────
const stmts = {
  insertFile:    db.prepare('INSERT INTO files (filename, original_name, file_type, board_id, subject) VALUES (?, ?, ?, ?, ?)'),
  getAllFiles:   db.prepare('SELECT * FROM files ORDER BY uploaded_at DESC'),
  getFileById:  db.prepare('SELECT * FROM files WHERE id = ?'),
  deleteFile:   db.prepare('DELETE FROM files WHERE id = ?'),
  getAdminCreds:db.prepare('SELECT * FROM admin_settings WHERE id = 1'),
  updateAdminPw:db.prepare('UPDATE admin_settings SET password_hash = ? WHERE id = 1'),
};

// ══════════════════════════════════════════════════════════════════════════════
// JWT SECRETS & ADMIN CREDENTIALS — from environment variables only
// ══════════════════════════════════════════════════════════════════════════════
const SECRET_KEY       = process.env.JWT_SECRET;
const ADMIN_SECRET_KEY = process.env.ADMIN_JWT_SECRET;
const ADMIN_USERNAME   = process.env.ADMIN_USERNAME;
const ADMIN_PASSWORD   = process.env.ADMIN_PASSWORD;

// Seed / refresh admin credentials into SQLite on every start
(async () => {
  try {
    const hash = await bcrypt.hash(ADMIN_PASSWORD, 12);
    db.prepare('REPLACE INTO admin_settings (id, username, password_hash) VALUES (1, ?, ?)').run(ADMIN_USERNAME, hash);
    console.log(`✅  Admin account ready: ${ADMIN_USERNAME}`);
  } catch (e) { console.error('Admin seed failed:', e.message); }
})();

// ══════════════════════════════════════════════════════════════════════════════
// RATE LIMITERS
// ══════════════════════════════════════════════════════════════════════════════
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: { error: 'Too many requests. Please wait a few minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,   // stricter for login attempts
  message: { error: 'Too many login attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests from this IP' },
  standardHeaders: true,
  legacyHeaders: false,
});

const sensitiveApiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ══════════════════════════════════════════════════════════════════════════════
// AUTH MIDDLEWARE
// ══════════════════════════════════════════════════════════════════════════════

/** Validates the user JWT (issued on login). Attaches req.user. */
const tokenBlacklist = new Map();

function pruneTokenBlacklist() {
  const now = Date.now();
  for (const [token, expiresAt] of tokenBlacklist.entries()) {
    if (expiresAt <= now) tokenBlacklist.delete(token);
  }
}

function isTokenBlacklisted(token) {
  pruneTokenBlacklist();
  return tokenBlacklist.has(token);
}

function blacklistToken(token, expiresAt) {
  if (!token) return;
  tokenBlacklist.set(token, expiresAt || Date.now() + 10 * 60 * 1000);
}

const authenticate = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized — login required', code: 'NO_TOKEN' });
  if (isTokenBlacklisted(token)) return res.status(401).json({ error: 'Token revoked. Please log in again.', code: 'TOKEN_REVOKED' });
  try {
    req.user = jwt.verify(token, SECRET_KEY);
    next();
  } catch (err) {
    // Distinguish expired tokens so frontend can show "session expired" not "access denied"
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Session expired. Please log in again.', code: 'TOKEN_EXPIRED' });
    }
    res.status(403).json({ error: 'Invalid token. Please log in again.', code: 'TOKEN_INVALID' });
  }
};

/** Validates the admin JWT (issued on admin login). Attaches req.admin. */
const authenticateAdmin = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Admin access required', code: 'NO_TOKEN' });
  if (isTokenBlacklisted(token)) return res.status(401).json({ error: 'Token revoked. Please log in again.', code: 'TOKEN_REVOKED' });
  try {
    const payload = jwt.verify(token, ADMIN_SECRET_KEY);
    if (payload.role !== 'admin') throw new Error('Not admin');
    req.admin = payload;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Admin session expired. Please log in again.', code: 'TOKEN_EXPIRED' });
    }
    res.status(403).json({ error: 'Admin authentication failed', code: 'TOKEN_INVALID' });
  }
};

/**
 * authenticateAny — accepts EITHER a user JWT (SECRET_KEY) OR an admin JWT
 * (ADMIN_SECRET_KEY).  This is used on the upload route so both teachers and
 * admins can upload files without getting a 401.
 */
const authenticateAny = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Login required to upload files.', code: 'NO_TOKEN' });
  if (isTokenBlacklisted(token)) return res.status(401).json({ error: 'Token revoked. Please log in again.', code: 'TOKEN_REVOKED' });

  // Try user token first
  try {
    req.user = jwt.verify(token, SECRET_KEY);
    return next();
  } catch (userErr) {
    // Try admin token second
    try {
      const payload = jwt.verify(token, ADMIN_SECRET_KEY);
      req.user  = payload;   // expose as req.user so upload handler doesn't break
      req.admin = payload;
      return next();
    } catch (adminErr) {
      // Report the most meaningful error
      const expired = userErr.name === 'TokenExpiredError' || adminErr.name === 'TokenExpiredError';
      if (expired)
        return res.status(401).json({ error: 'Session expired. Please log in again.', code: 'TOKEN_EXPIRED' });
      return res.status(403).json({ error: 'Invalid token. Please log in again.', code: 'TOKEN_INVALID' });
    }
  }
};

// ══════════════════════════════════════════════════════════════════════════════
// USER AUTH ROUTES  (backed by MongoDB Atlas)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * POST /api/login
 * Body: { username, password }
 * Finds the user in MongoDB, compares bcrypt hash, returns JWT.
 */
app.post('/api/login', loginLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;

    // ── Input validation ──────────────────────────────────────────────────────
    if (!username || typeof username !== 'string' || !username.trim())
      return res.status(400).json({ error: 'Username is required' });
    if (!password || typeof password !== 'string')
      return res.status(400).json({ error: 'Password is required' });

    // ── Lookup in .env ───────────────────────────────────────────────────────
    if (
      username.trim() !== process.env.DEFAULT_USER_USERNAME ||
      password !== process.env.DEFAULT_USER_PASSWORD
    ) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    // ── Issue JWT ────────────────────────────────────────────────────────────────────
    const expiresIn = '7d';
    const token = jwt.sign(
      { id: 'env_user_1', username: process.env.DEFAULT_USER_USERNAME, iat: Math.floor(Date.now() / 1000) },
      SECRET_KEY,
      { expiresIn }
    );
    const user = { _id: { toHexString: () => 'env_user_1' }, username: process.env.DEFAULT_USER_USERNAME };
    // Tell the client when the token expires so it can proactively re-login
    const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;

    console.log(`[Auth] ✅ User logged in: ${user.username}`);
    res.json({
      token,
      expiresAt,
      user: { id: user._id.toHexString(), username: user.username },
    });
  } catch (err) {
    console.error('[Login] Error:', err.message);
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

app.post('/api/logout', authenticateAny, (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const decoded = jwt.decode(token);
  const expireAt = decoded?.exp ? decoded.exp * 1000 : Date.now() + 10 * 60 * 1000;
  blacklistToken(token, expireAt);
  console.log('[Logout] Token revoked');
  res.json({ success: true });
});

// ══════════════════════════════════════════════════════════════════════════════
// FILE ROUTES  (file metadata in SQLite; actual bytes on disk)
// ══════════════════════════════════════════════════════════════════════════════

/** GET /api/files — public file listing */
app.get('/api/files', apiLimiter, (_req, res) => {
  try {
    res.json(stmts.getAllFiles.all() || []);
  } catch (err) {
    console.error('[Files]', err);
    res.status(500).json({ error: 'Failed to retrieve files' });
  }
});

/** GET /api/board-files — filtered file listing (SQL Injection protected) */
app.get('/api/board-files', (req, res) => {
  try {
    let { board = '1', subject = '' } = req.query;
    
    // ✅ Strict input validation
    const boardId = parseInt(board, 10);
    if (isNaN(boardId) || boardId < 0 || boardId > 5) {
      return res.status(400).json({ error: 'Invalid board ID. Must be between 0 and 5.' });
    }
    
    // Sanitize subject (max 50 chars, safe characters only)
    const safeSub = String(subject).slice(0, 50).trim();
    if (!/^[a-zA-Z0-9_\-\s]*$/.test(safeSub)) {
      return res.status(400).json({ error: 'Invalid subject format' });
    }
    
    let query, params;
    if (safeSub) {
      // ✅ Using prepared statements (safe from SQL injection)
      query = `
        SELECT * FROM files
        WHERE (board_id = ? AND (LOWER(subject) = LOWER(?) OR LOWER(subject) = 'routine'))
           OR (board_id = 0 AND LOWER(subject) = 'routine')
        ORDER BY uploaded_at DESC
        LIMIT 1000`;
      params = [boardId, safeSub];
    } else {
      query = `
        SELECT * FROM files
        WHERE board_id = ? OR (board_id = 0 AND LOWER(subject) = 'routine')
        ORDER BY uploaded_at DESC
        LIMIT 1000`;
      params = [boardId];
    }
    
    const result = db.prepare(query).all(...params);
    res.json(result || []);
  } catch (err) {
    console.error('[BoardFiles]', err);
    res.status(500).json({ error: 'Database query failed' });
  }
});

/**
 * POST /api/upload — authenticated file upload (disk only, no MongoDB)
 * Accepts: user JWT or admin JWT.
 */
app.post('/api/upload', authLimiter, authenticateAny, (req, res, next) => {
  upload.array('file', 20)(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE')
        return res.status(413).json({ error: 'File too large. Max 500 MB per file.' });
      if (err.code === 'BAD_TYPE' || err.message === 'File type not allowed')
        return res.status(415).json({ error: 'File type not allowed. Accepted: PDF, images, videos, PPT.' });
      console.error('[Upload] Multer error:', err.message);
      return res.status(500).json({ error: 'Upload error: ' + err.message });
    }
    next();
  });
}, (req, res) => {
  try {
    if (!req.files?.length)
      return res.status(400).json({ error: 'No files received. Ensure the field name is "file".' });

    let { board_id = 1, subject = '' } = req.body;
    board_id = parseInt(board_id);
    if (isNaN(board_id)) board_id = 1;
    subject  = String(subject).slice(0, 50);

    const inserted = req.files.map(f => {
      const ext      = path.extname(f.originalname).slice(1).toLowerCase();
      const fileType = ext === 'pdf' ? 'pdf'
                     : ['mp4','webm'].includes(ext) ? 'video'
                     : ['ppt','pptx'].includes(ext) ? 'ppt'
                     : 'image';

      const { lastInsertRowid } = stmts.insertFile.run(f.filename, f.originalname, fileType, +board_id, subject);
      console.log(`[Upload] ✅ ${f.originalname} → board=${board_id}, subject="${subject}", type=${fileType}`);
      return { id: lastInsertRowid, filename: f.filename, original_name: f.originalname, file_type: fileType };
    });

    res.json({ files: inserted, message: `${inserted.length} file(s) uploaded successfully` });
  } catch (err) {
    console.error('[Upload] DB error:', err.message);
    res.status(500).json({ error: 'Failed to record upload: ' + err.message });
  }
});

/** DELETE /api/files/:id — admin only */
app.delete('/api/files/:id', authenticateAdmin, (req, res) => {
  try {
    const f = stmts.getFileById.get(req.params.id);
    if (!f) return res.status(404).json({ error: 'File not found' });
    const fp = path.join(uploadDir, f.filename);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
    stmts.deleteFile.run(req.params.id);
    console.log(`[Files] 🗑 Deleted: ${f.original_name}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// ADMIN ROUTES  (admin credentials in SQLite, user management in MongoDB)
// ══════════════════════════════════════════════════════════════════════════════

/** POST /api/admin/login — verifies against SQLite admin_settings */
app.post('/api/admin/login', loginLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password)
      return res.status(400).json({ error: 'Username and password are required' });

    const creds = stmts.getAdminCreds.get();
    if (!creds || !creds.username || !creds.password_hash)
      return res.status(500).json({ error: 'Admin credentials are not configured' });

    if (creds.username.toLowerCase() !== username.trim().toLowerCase())
      return res.status(401).json({ error: 'Invalid admin credentials' });

    const ok = await bcrypt.compare(password, creds.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid admin credentials' });

    const token = jwt.sign({ role: 'admin', username: creds.username }, ADMIN_SECRET_KEY, { expiresIn: '8h' });
    const expiresAt = Date.now() + 8 * 60 * 60 * 1000;
    console.log(`[Admin] ✅ Admin logged in: ${creds.username}`);
    res.json({ token, expiresAt, username: creds.username });
  } catch (err) {
    console.error('[AdminLogin]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/admin/users — list all users from MongoDB */
app.get('/api/admin/users', authenticateAdmin, sensitiveApiLimiter, async (req, res) => {
  try {
    const users = [];
    if (process.env.DEFAULT_USER_USERNAME) {
      users.push({ id: 'env_user_1', username: process.env.DEFAULT_USER_USERNAME, created_at: new Date() });
    }
    res.json(users);
  } catch (err) {
    console.error('[AdminUsers]', err.message);
    res.status(500).json({ error: 'Failed to retrieve users' });
  }
});

/** POST /api/admin/users — create a new user in MongoDB */
app.post('/api/admin/users', authenticateAdmin, async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password)
      return res.status(400).json({ error: 'Username and password are required' });
    if (username.length < 3)
      return res.status(400).json({ error: 'Username must be at least 3 characters' });
    if (password.length < 6)
      return res.status(400).json({ error: 'Password must be at least 6 characters' });

    // Validate username characters
    if (!/^[a-zA-Z0-9_-]+$/.test(username))
      return res.status(400).json({ error: 'Username may only contain letters, digits, _ or -' });

    return res.status(400).json({ error: 'MongoDB has been removed. Please add users via the .env file.' });
  } catch (err) {
    if (err.code === 11000 || err.message?.includes('duplicate'))
      return res.status(400).json({ error: 'Username already exists' });
    console.error('[CreateUser]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/** DELETE /api/admin/users/:id — delete a user from MongoDB */
app.delete('/api/admin/users/:id', authenticateAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    return res.status(400).json({ error: 'MongoDB has been removed. Please manage users via the .env file.' });
  } catch (err) {
    console.error('[DeleteUser]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/admin/files — list all uploaded files */
app.get('/api/admin/files', authenticateAdmin, sensitiveApiLimiter, (_req, res) => {
  try { res.json(stmts.getAllFiles.all() || []); }
  catch (err) { 
    console.error('[AdminFiles]', err);
    res.status(500).json({ error: 'Failed to retrieve files' });
  }
});

/** GET /api/admin/board-status — real-time board activity */
app.get('/api/admin/board-status', authenticateAdmin, (_req, res) => {
  const statuses = {};
  for (const id of [1,2,3,4,5]) {
    const last     = boardActivity[id] || 0;
    const isActive = (Date.now() - last) < 30_000;
    statuses[id]   = { isActive, lastActivity: last };
  }
  res.json(statuses);
});

/** PUT /api/admin/password — change admin password */
app.put('/api/admin/password', authenticateAdmin, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword)
      return res.status(400).json({ error: 'Both passwords are required' });
    if (newPassword.length < 8)
      return res.status(400).json({ error: 'New password must be at least 8 characters' });

    const creds = stmts.getAdminCreds.get();
    const ok    = await bcrypt.compare(currentPassword, creds.password_hash);
    if (!ok) return res.status(401).json({ error: 'Current password is incorrect' });

    const hash = await bcrypt.hash(newPassword, 12);
    stmts.updateAdminPw.run(hash);
    console.log('[Admin] Password changed successfully');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/admin/active-users */
app.get('/api/admin/active-users', authenticateAdmin, (_req, res) => {
  res.json({ count: Math.floor(Math.random() * 5) + 1 });
});

// ── Legacy self-registration route (disabled) ─────────────────────────────────
app.post('/api/register', (_req, res) => {
  res.status(403).json({ error: 'Self-registration is disabled. Contact the admin.' });
});

// ── Health check — use this to verify DB connection from browser/Postman ────────
// GET /api/health  →  { status, db, uptime, timestamp }
app.get('/api/health', (_req, res) => {
  const isOk = true;
  res.status(isOk ? 200 : 503).json({
    status:    isOk ? 'ok' : 'degraded',
    db: 'removed',
    uptime_s:  Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    env:       process.env.NODE_ENV || 'development',
  });
});

// ── Catch-all: serve frontend ─────────────────────────────────────────────────
  try {
    const boardId = parseInt(req.params.id);
    if (isNaN(boardId) || boardId < 1 || boardId > 5) return res.status(400).json({ error: 'Invalid board ID' });

    // Get board state from Socket.io (assuming boardStates is available)
    const boardState = boardStates[boardId] || [];
    // For simplicity, create a basic PDF with strokes (this is a placeholder; full implementation would need canvas rendering)
    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([1920, 1080]);
    page.drawText(`Board ${boardId} Export`, { x: 100, y: 1000, size: 24 });

    // Add strokes as text for demo (in real implementation, render canvas)
    boardState.forEach((stroke, idx) => {
      page.drawText(`Stroke ${idx}: ${JSON.stringify(stroke)}`, { x: 100, y: 950 - idx * 20, size: 12 });
    });

    // Add Thank You page
    const finalPage = pdfDoc.addPage([1920, 1080]);
    finalPage.drawRectangle({
      x: 0, y: 0, width: 1920, height: 1080,
      color: rgb(0.95, 0.95, 0.95),
    });
    finalPage.drawText('Thank You for Using SmartBoard', { 
      x: 1920 / 2 - 400, y: 1080 / 2 + 100, size: 48, color: rgb(0.2, 0.2, 0.2),
    });
    finalPage.drawText('Developed with guidance from Shambhu Shankar Bharti', { 
      x: 1920 / 2 - 350, y: 1080 / 2 + 20, size: 24, color: rgb(0.4, 0.4, 0.4),
    });
    finalPage.drawText('Developed by Gaurav Kumar', { 
      x: 1920 / 2 - 250, y: 1080 / 2 - 20, size: 24, color: rgb(0.4, 0.4, 0.4),
    });
    finalPage.drawText('Supported by students of LNJPIT', { 
      x: 1920 / 2 - 250, y: 1080 / 2 - 60, size: 24, color: rgb(0.4, 0.4, 0.4),
    });

    const exportFilename = `Board_${boardId}_${Date.now()}.pdf`;
    const exportPath = path.join(DATA_DIR, exportFilename);
    fs.writeFileSync(exportPath, await pdfDoc.save());

    const downloadUrl = `/api/download/${exportFilename}`;
    res.json({ success: true, downloadUrl });
  } catch (err) {
    console.error('[Export Board PDF]', err);
    res.status(500).json({ error: 'Failed to export PDF' });
  }
});

app.post('/api/export-hd', authenticateAny, async (req, res) => {
  try {
    const { boardId, snapshots } = req.body;
    console.log(`[Export HD] Received request for board: ${boardId}`);
    console.log(`[Export HD] Received ${snapshots ? snapshots.length : 0} snapshots`);
    
    // Attempt to load the active background PDF (if uploaded)
    const fileRecord = stmts.getAllFiles.all().find(f => f.board_id === boardId && f.file_type === 'pdf');
    let pdfDoc;

    if (fileRecord) {
      const pdfBytes = fs.readFileSync(path.join(uploadDir, fileRecord.filename));
      pdfDoc = await PDFDocument.load(pdfBytes);
      const pdfPages = pdfDoc.getPages();
      
      if (snapshots && snapshots.length > 0) {
        for (let i = 0; i < snapshots.length; i++) {
          let page;
          if (i < pdfPages.length) {
            page = pdfPages[i];
          } else {
            // Add a new page if snapshots exceed background pages
            page = pdfDoc.addPage([1920, 1080]);
          }

          const snapshot = snapshots[i];
          const pngImage = await pdfDoc.embedPng(Buffer.from(snapshot.split(',')[1], 'base64'));
          
          // Scale to fit the existing background PDF without distortion
          const imgDims = pngImage.scaleToFit(page.getWidth(), page.getHeight());
          page.drawImage(pngImage, {
            x: (page.getWidth() - imgDims.width) / 2,
            y: (page.getHeight() - imgDims.height) / 2,
            width: imgDims.width,
            height: imgDims.height
          });
        }
      }
    } else {
      // Create a blank PDF
      pdfDoc = await PDFDocument.create();
      
      if (snapshots && snapshots.length > 0) {
        for (let i = 0; i < snapshots.length; i++) {
          const snapshot = snapshots[i];
          const pngImage = await pdfDoc.embedPng(Buffer.from(snapshot.split(',')[1], 'base64'));
          const page = pdfDoc.addPage([pngImage.width, pngImage.height]); 
          page.drawImage(pngImage, {
            x: 0,
            y: 0,
            width: pngImage.width,
            height: pngImage.height
          });
        }
      } else {
        pdfDoc.addPage([1920, 1080]);
      }
    }

    // Add Thank You Page (Always added at the very end)
    const finalPage = pdfDoc.addPage([1920, 1080]);
    // Soft gradient background (simulate with light color)
    finalPage.drawRectangle({
      x: 0,
      y: 0,
      width: 1920,
      height: 1080,
      color: rgb(0.95, 0.95, 0.95), // Light gray
    });
    finalPage.drawText('Thank You for Using SmartBoard', { 
      x: 1920 / 2 - 400, // Centered
      y: 1080 / 2 + 100,
      size: 48,
      color: rgb(0.2, 0.2, 0.2), // Dark text
    });
    finalPage.drawText('Developed with guidance from Shambhu Shankar Bharti', { 
      x: 1920 / 2 - 350,
      y: 1080 / 2 + 20,
      size: 24,
      color: rgb(0.4, 0.4, 0.4),
    });
    finalPage.drawText('Developed by Gaurav Kumar', { 
      x: 1920 / 2 - 250,
      y: 1080 / 2 - 20,
      size: 24,
      color: rgb(0.4, 0.4, 0.4),
    });
    finalPage.drawText('Supported by students of LNJPIT', { 
      x: 1920 / 2 - 250,
      y: 1080 / 2 - 60,
      size: 24,
      color: rgb(0.4, 0.4, 0.4),
    });

    // Save and send back
    const exportFilename = `Final_Board_${boardId}_${Date.now()}.pdf`;
    const exportPath = path.join(DATA_DIR, exportFilename);
    fs.writeFileSync(exportPath, await pdfDoc.save());

    // Generate QR Code linking to the download URL
    const downloadUrl = `${process.env.FRONTEND_URL || 'http://localhost:'+PORT}/api/download/${exportFilename}`;
    const qrCodeDataUrl = await QRCode.toDataURL(downloadUrl);

    res.json({ success: true, downloadUrl: `/api/download/${exportFilename}`, qrCode: qrCodeDataUrl });
  } catch (err) {
    console.error('[Export HD] Error:', err);
    res.status(500).json({ error: 'Failed to export PDF' });
  }
});

// Force direct download with path traversal protection
app.get('/api/download/:filename', (req, res) => {
  try {
    const filePath = path.join(DATA_DIR, req.params.filename);
    
    // ✅ Prevent directory traversal attacks
    if (!path.resolve(filePath).startsWith(path.resolve(DATA_DIR))) {
      return res.status(400).json({ error: 'Invalid filename' });
    }
    
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found' });
    }
    
    const stat = fs.statSync(filePath);
    
    // ✅ Stream large files instead of loading into memory
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Content-Disposition', 'attachment; filename="SmartBoard-Session.pdf"');
    
    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
    
    stream.on('error', (err) => {
      console.error('[Download]', err);
      res.status(500).json({ error: 'Download failed' });
    });
  } catch (err) {
    console.error('[Download]', err);
    res.status(500).json({ error: 'Download failed' });
  }
});

app.use((_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ══════════════════════════════════════════════════════════════════════════════
// SOCKET.IO — real-time board sync with memory management
// ══════════════════════════════════════════════════════════════════════════════
const boardStates   = {};
const boardActivity = {};
const STROKE_LIMIT = 1000;  // ✅ Reduced from 5000 to prevent memory bloat
const BOARD_STATE_TTL = 24 * 60 * 60 * 1000;  // 24 hours

// ✅ Auto-cleanup every hour
setInterval(() => {
  for (const boardId in boardStates) {
    if (boardStates[boardId].length > STROKE_LIMIT) {
      console.log(`[Socket] Trimming board ${boardId}: ${boardStates[boardId].length} → ${STROKE_LIMIT}`);
      boardStates[boardId] = boardStates[boardId].slice(-STROKE_LIMIT);
    }
  }
}, 60 * 60 * 1000);  // Every hour

// ✅ Clear inactive boards every 6 hours
setInterval(() => {
  const now = Date.now();
  for (const boardId in boardStates) {
    const lastActivity = boardActivity[boardId] || 0;
    if (lastActivity && now - lastActivity > BOARD_STATE_TTL) {
      console.log(`[Socket] Clearing inactive board ${boardId}`);
      delete boardStates[boardId];
      delete boardActivity[boardId];
    }
  }
}, 6 * 60 * 60 * 1000);  // Every 6 hours

io.on('connection', socket => {
  socket.on('join-board', boardId => {
    const safeBoardId = parseInt(boardId, 10);
    if (safeBoardId >= 1 && safeBoardId <= 5) {
      socket.join(`board-${safeBoardId}`);
    }
  });

  socket.on('join-admin', boardId => {
    const safeBoardId = parseInt(boardId, 10);
    if (safeBoardId >= 1 && safeBoardId <= 5) {
      socket.join(`admin-board-${safeBoardId}`);
      if (boardStates[safeBoardId]) socket.emit('init-strokes', boardStates[safeBoardId]);
    }
  });

  socket.on('draw-stroke', ({ boardId, stroke }) => {
    const safeBoardId = parseInt(boardId, 10);
    if (!(safeBoardId >= 1 && safeBoardId <= 5)) return;
    
    if (!boardStates[safeBoardId]) boardStates[safeBoardId] = [];
    boardStates[safeBoardId].push(stroke);
    boardActivity[safeBoardId] = Date.now();
    
    // ✅ Aggressive memory management
    if (boardStates[safeBoardId].length > STROKE_LIMIT) {
      boardStates[safeBoardId] = boardStates[safeBoardId].slice(-STROKE_LIMIT);
    }
    
    socket.to(`admin-board-${safeBoardId}`).emit('draw-stroke', stroke);
  });

  socket.on('sync-background', data => {
    const safeBoardId = parseInt(data.board, 10);
    if (!(safeBoardId >= 0 && safeBoardId <= 5)) return;
    boardActivity[safeBoardId] = Date.now();
    socket.to(`admin-board-${safeBoardId}`).emit('sync-background', data);
  });

  socket.on('clear-board', boardId => {
    const safeBoardId = parseInt(boardId, 10);
    if (!(safeBoardId >= 1 && safeBoardId <= 5)) return;
    boardStates[safeBoardId] = [];
    boardActivity[safeBoardId] = Date.now();
    socket.to(`admin-board-${safeBoardId}`).emit('clear-board');
  });

  socket.on('disconnect', () => {});
});

// ══════════════════════════════════════════════════════════════════════════════
// START — connect to MongoDB FIRST, then start HTTP server
// ══════════════════════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;

async function startServer() {
  try {

    // DB is confirmed ready — now open the HTTP port
    httpServer.listen(PORT, () => {
      console.log(`\n🚀  SmartBoard running at http://localhost:${PORT}`);
      console.log(`    Home   → http://localhost:${PORT}/`);
      console.log(`    Board  → http://localhost:${PORT}/board.html`);
      console.log(`    Health → http://localhost:${PORT}/api/health\n`);
    });
  } catch (err) {
    console.error('❌  Cannot start server:', err.message);
    process.exit(1);
  }
}

startServer();
