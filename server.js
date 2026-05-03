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
const mongoose  = require('mongoose');
const Database  = require('better-sqlite3');
const multer    = require('multer');
const bcrypt    = require('bcrypt');
const jwt       = require('jsonwebtoken');
const cors      = require('cors');
const path      = require('path');
const fs        = require('fs');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');

// ── MongoDB User model (username + hashed password only) ─────────────────────
const User = require('./models/User');

// ── App & HTTP server ─────────────────────────────────────────────────────────
const app        = express();
const httpServer = require('http').createServer(app);
const io         = require('socket.io')(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

// ── Security headers ──────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy:     false, // allow CDNs for PDF.js / FontAwesome
  crossOriginResourcePolicy: false,
}));
app.use(express.json({ limit: '50kb' }));

// ── CORS — allow both Vercel frontend and local dev ───────────────────────────
const ALLOWED_ORIGINS = [
  // Add your Vercel URL here (no trailing slash)
  process.env.FRONTEND_URL,
  'http://localhost:3000',
  'http://localhost:5173',
].filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (Render health pings, Postman, etc.)
    if (!origin) return cb(null, true);
    // Allow if in whitelist OR if no whitelist configured (dev mode)
    if (!ALLOWED_ORIGINS.length || ALLOWED_ORIGINS.includes(origin))
      return cb(null, true);
    cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,
}));

app.use(express.static(path.join(__dirname, 'public')));

// ══════════════════════════════════════════════════════════════════════════════
// MONGODB ATLAS — connection helper with retry logic
// ══════════════════════════════════════════════════════════════════════════════
const MONGO_URI = process.env.MONGODB_URI;
if (!MONGO_URI) {
  console.error('❌  MONGODB_URI is not set in .env or Render environment variables.');
  process.exit(1);
}

// Mongoose global settings
mongoose.set('strictQuery', true);

// Connection event logging (never logs the URI itself — no credential leak)
mongoose.connection.on('connected',     () => console.log('✅  MongoDB Atlas connected'));
mongoose.connection.on('disconnected',  () => console.warn('⚠️  MongoDB disconnected'));
mongoose.connection.on('reconnected',   () => console.log('✅  MongoDB reconnected'));
mongoose.connection.on('error',   err  => console.error('❌  MongoDB error:', err.message));

/**
 * connectWithRetry — attempts to connect to Atlas up to `maxRetries` times
 * with exponential back-off. Render cold starts can take 15-30 s, so we
 * give the network time to settle before giving up.
 */
async function connectWithRetry(maxRetries = 5) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await mongoose.connect(MONGO_URI, {
        serverSelectionTimeoutMS: 15_000,
        socketTimeoutMS:          45_000,
        // Mongoose handles reconnect via useNewUrlParser default in v7
      });
      return; // success
    } catch (err) {
      const isLast = attempt === maxRetries;
      // Log error message only — never the URI (contains password)
      console.error(`❌  MongoDB connect attempt ${attempt}/${maxRetries} failed: ${err.message}`);
      if (isLast) throw err;
      const wait = 2_000 * attempt; // 2s, 4s, 6s, 8s, 10s
      console.log(`⏳  Retrying in ${wait / 1000}s…`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
}

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

const fileFilter = (_req, file, cb) => {
  if (/\.(pdf|jpg|jpeg|png|gif|webp|mp4|webm|ppt|pptx)$/i.test(file.originalname))
    cb(null, true);
  else
    cb(Object.assign(new Error('File type not allowed'), { code: 'BAD_TYPE' }));
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
if (!process.env.JWT_SECRET || !process.env.ADMIN_JWT_SECRET) {
  console.warn('⚠️   JWT_SECRET / ADMIN_JWT_SECRET not set — using insecure dev defaults!');
}
const SECRET_KEY       = process.env.JWT_SECRET       || 'sb_jwt_secret_dev_CHANGE_ME';
const ADMIN_SECRET_KEY = process.env.ADMIN_JWT_SECRET || 'sb_admin_jwt_dev_CHANGE_ME';
const ADMIN_USERNAME   = process.env.ADMIN_USERNAME   || 'Gaurav';
const ADMIN_PASSWORD   = process.env.ADMIN_PASSWORD   || 'gk07011019';

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
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,   // stricter for login attempts
  message: { error: 'Too many login attempts. Please try again later.' },
});

// ══════════════════════════════════════════════════════════════════════════════
// AUTH MIDDLEWARE
// ══════════════════════════════════════════════════════════════════════════════

/** Validates the user JWT (issued on login). Attaches req.user. */
const authenticate = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized — login required', code: 'NO_TOKEN' });
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

    // ── Lookup in MongoDB (also selects +password field) ─────────────────────
    const user = await User.findByLogin(username.trim());
    if (!user)
      return res.status(401).json({ error: 'Invalid username or password' });

    // ── Compare password ──────────────────────────────────────────────────────
    const match = await user.comparePassword(password);
    if (!match)
      return res.status(401).json({ error: 'Invalid username or password' });

    // ── Issue JWT ────────────────────────────────────────────────────────────────────
    const expiresIn = '7d';
    const token = jwt.sign(
      { id: user._id.toHexString(), username: user.username, iat: Math.floor(Date.now() / 1000) },
      SECRET_KEY,
      { expiresIn }
    );
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

// ══════════════════════════════════════════════════════════════════════════════
// FILE ROUTES  (file metadata in SQLite; actual bytes on disk)
// ══════════════════════════════════════════════════════════════════════════════

/** GET /api/files — public file listing */
app.get('/api/files', (_req, res) => {
  try {
    res.json(stmts.getAllFiles.all() || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/board-files — filtered file listing */
app.get('/api/board-files', (req, res) => {
  try {
    let { board = '1', subject = '' } = req.query;
    board   = parseInt(board);
    if (isNaN(board)) board = 1;
    subject = String(subject).slice(0, 50);

    let query, params;
    if (subject) {
      query = `
        SELECT * FROM files
        WHERE (board_id = ? AND (LOWER(subject) = LOWER(?) OR LOWER(subject) = 'routine'))
           OR (board_id = 0 AND LOWER(subject) = 'routine')
        ORDER BY uploaded_at DESC`;
      params = [+board, subject];
    } else {
      query = `
        SELECT * FROM files
        WHERE board_id = ?
           OR (board_id = 0 AND LOWER(subject) = 'routine')
        ORDER BY uploaded_at DESC`;
      params = [+board];
    }

    res.json(db.prepare(query).all(...params) || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/gate-questions — Load GATE PYQ dataset */
app.get('/api/gate-questions', (_req, res) => {
  try {
    const dataPath = path.join(__dirname, 'data', 'gate_questions.json');
    if (fs.existsSync(dataPath)) {
      const questions = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
      res.json(questions);
    } else {
      res.status(404).json({ error: 'GATE questions dataset not found' });
    }
  } catch (err) {
    res.status(500).json({ error: 'Error loading GATE questions: ' + err.message });
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
    if (!creds) return res.status(500).json({ error: 'Admin account not configured' });

    if (username.toLowerCase() !== creds.username.toLowerCase())
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
app.get('/api/admin/users', authenticateAdmin, async (req, res) => {
  try {
    // Exclude password hash; return id, username, created_at
    const users = await User.find({}, 'username created_at').lean();
    // Normalise _id → id for frontend compatibility
    res.json(users.map(u => ({ id: u._id.toHexString(), username: u.username, created_at: u.created_at })));
  } catch (err) {
    console.error('[AdminUsers]', err.message);
    res.status(500).json({ error: err.message });
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

    // The pre-save hook in User.js automatically bcrypt-hashes the password before saving
    const newUser = new User({ username: username.trim(), password });
    await newUser.save();

    console.log(`[Admin] ✅ Created user: ${newUser.username}`);
    res.json({ id: newUser._id.toHexString(), username: newUser.username });
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
    if (!mongoose.Types.ObjectId.isValid(id))
      return res.status(400).json({ error: 'Invalid user ID' });

    const deleted = await User.findByIdAndDelete(id);
    if (!deleted) return res.status(404).json({ error: 'User not found' });

    console.log(`[Admin] 🗑 Deleted user: ${deleted.username}`);
    res.json({ success: true });
  } catch (err) {
    console.error('[DeleteUser]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/admin/files — list all uploaded files */
app.get('/api/admin/files', authenticateAdmin, (_req, res) => {
  try { res.json(stmts.getAllFiles.all() || []); }
  catch (err) { res.status(500).json({ error: err.message }); }
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

/** 
 * GET /api/admin/export-board-pdf/:id
 * Returns a URL that triggers client-side PDF export for a specific board.
 */
app.get('/api/admin/export-board-pdf/:id', authenticateAdmin, (req, res) => {
  const boardId = req.params.id;
  
  // Find the latest non-routine file for this board to use as background
  const latestFile = db.prepare('SELECT filename FROM files WHERE board_id = ? AND LOWER(subject) != "routine" ORDER BY uploaded_at DESC LIMIT 1').get(boardId);
  
  let downloadUrl = `/board.html?board=${boardId}&export=true`;
  if (latestFile) {
    downloadUrl += `&fileUrl=${encodeURIComponent('/uploads/' + latestFile.filename)}`;
  }

  res.json({
    success: true,
    downloadUrl: downloadUrl
  });
});

// ── Health check — use this to verify DB connection from browser/Postman ────────
// GET /api/health  →  { status, db, uptime, timestamp }
app.get('/api/health', (_req, res) => {
  const dbState = mongoose.connection.readyState;
  // 0=disconnected, 1=connected, 2=connecting, 3=disconnecting
  const stateMap = { 0: 'disconnected', 1: 'connected', 2: 'connecting', 3: 'disconnecting' };
  const isOk     = dbState === 1;
  res.status(isOk ? 200 : 503).json({
    status:    isOk ? 'ok' : 'degraded',
    db:        stateMap[dbState] || 'unknown',
    uptime_s:  Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    env:       process.env.NODE_ENV || 'development',
  });
});

// ── Catch-all: serve frontend ─────────────────────────────────────────────────
app.use((_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ══════════════════════════════════════════════════════════════════════════════
// SOCKET.IO — real-time board sync
// ══════════════════════════════════════════════════════════════════════════════
const boardStates   = {}; // Structure: { [boardId]: { [pageIdx]: [strokes] } }
const boardActivity = {};

io.on('connection', socket => {
  socket.on('join-board', boardId => {
    socket.join(`board-${boardId}`);
    if (boardStates[boardId]) socket.emit('init-strokes', boardStates[boardId]);
  });

  socket.on('join-admin', boardId => {
    socket.join(`admin-board-${boardId}`);
    if (boardStates[boardId]) socket.emit('init-strokes', boardStates[boardId]);
  });

  socket.on('draw-stroke', ({ boardId, pageIdx = 0, stroke }) => {
    if (!boardStates[boardId]) boardStates[boardId] = {};
    if (!boardStates[boardId][pageIdx]) boardStates[boardId][pageIdx] = [];
    
    boardStates[boardId][pageIdx].push(stroke);
    boardActivity[boardId] = Date.now();
    
    socket.to(`admin-board-${boardId}`).emit('draw-stroke', { pageIdx, stroke });
    socket.to(`board-${boardId}`).emit('draw-stroke', { pageIdx, stroke });
  });

  socket.on('sync-background', data => {
    boardActivity[data.board] = Date.now();
    // Update server's state for this page if strokes are provided
    if (data.pageIndex !== undefined && data.strokes) {
      if (!boardStates[data.board]) boardStates[data.board] = {};
      boardStates[data.board][data.pageIndex] = data.strokes;
    }
    socket.to(`admin-board-${data.board}`).emit('sync-background', data);
    socket.to(`board-${data.board}`).emit('sync-background', data);
  });

  socket.on('clear-board', ({ boardId, pageIdx = 0 }) => {
    if (boardStates[boardId]) {
      boardStates[boardId][pageIdx] = [];
    }
    boardActivity[boardId] = Date.now();
    socket.to(`admin-board-${boardId}`).emit('clear-board', { pageIdx });
    socket.to(`board-${boardId}`).emit('clear-board', { pageIdx });
  });

  socket.on('disconnect', () => {});
});

// ══════════════════════════════════════════════════════════════════════════════
// START — connect to MongoDB FIRST, then start HTTP server
// ══════════════════════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;

async function startServer() {
  try {
    console.log('⏳  Connecting to MongoDB Atlas…');
    await connectWithRetry(5);
    // DB is confirmed ready — now open the HTTP port
    httpServer.listen(PORT, () => {
      console.log(`\n🚀  SmartBoard running at http://localhost:${PORT}`);
      console.log(`    Home   → http://localhost:${PORT}/`);
      console.log(`    Board  → http://localhost:${PORT}/board.html`);
      console.log(`    Health → http://localhost:${PORT}/api/health\n`);
    });
  } catch (err) {
    console.error('❌  Cannot start server: MongoDB unreachable after retries.');
    console.error('    Check MONGODB_URI, Atlas Network Access, and cluster status.');
    process.exit(1);
  }
}

startServer();