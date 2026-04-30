# SmartBoard Hybrid Architecture & Implementation Plan

This architecture redesign strictly separates lightweight authentication from heavy application data to optimize your MongoDB Atlas free-tier usage while maintaining a robust, real-time SmartBoard experience.

## 1. Final Architecture Design (MongoDB + SQLite Separation)

**Dual-Database Approach:**
1. **MongoDB Atlas (Cloud):** Strictly restricted to User Authentication (`name`, `email`, `password_hash`, `role`).
2. **SQLite (Local/Disk):** Handles all heavy and frequent writes (`Files`, `Board Sessions`, `Activity Logs`).
3. **Socket.IO (In-Memory Cache):** Manages ultra-fast live drawing states, only flushing to SQLite periodically or when a board session ends.

## 2. Database Schemas

### MongoDB Atlas Schema (Authentication ONLY)
```javascript
// models/User.js (Mongoose)
const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  email: { type: String, sparse: true },
  password: { type: String, required: true }, // Hashed
  role: { type: String, enum: ['student', 'admin'], default: 'student' }
}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);
```

### SQLite Schema (Heavy Data Storage)
```javascript
// database.js (better-sqlite3)
const Database = require('better-sqlite3');
const db = new Database('./data/smartboard.sqlite', { verbose: console.log });
db.pragma('journal_mode = WAL'); // High performance writes

db.exec(`
  -- 1. Files Schema
  CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fileName TEXT NOT NULL,
    originalName TEXT NOT NULL,
    fileType TEXT DEFAULT 'pdf', -- pdf, image, video
    size INTEGER,
    boardId INTEGER NOT NULL,
    uploadedBy TEXT, -- MongoDB ObjectId as string
    uploadedAt DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- 2. Board Sessions Schema
  CREATE TABLE IF NOT EXISTS board_sessions (
    sessionId TEXT PRIMARY KEY,
    boardId INTEGER NOT NULL,
    activePdfId INTEGER,
    currentSlide INTEGER DEFAULT 1,
    boardState TEXT, -- JSON stringified array of ink strokes
    activeUsers TEXT, -- JSON array of active user IDs
    lastUpdated DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- 3. Activity / Logs Schema
  CREATE TABLE IF NOT EXISTS activity_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actionType TEXT, -- draw, upload, clear, export
    userId TEXT,
    boardId INTEGER,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

module.exports = db;
```

## 3. Node.js Integration Structure

```javascript
// server.js Setup
const express = require('express');
const mongoose = require('mongoose');
const db = require('./database'); // SQLite
const jwt = require('jsonwebtoken');

const app = express();

// MongoDB connects purely for auth
mongoose.connect(process.env.MONGODB_URI);

// Auth Middleware reads from JWT, doesn't need to hit DB for every request
const authenticate = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).send('Unauthorized');
  
  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).send('Invalid Token');
    req.user = decoded; // { id, username, role }
    next();
  });
};

const authenticateAdmin = (req, res, next) => {
  authenticate(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).send('Admin only');
    next();
  });
};
```

## 4. Socket.io Real-Time Flow

We keep MongoDB completely free of active socket connections.

```javascript
const io = require('socket.io')(server);
const boardStates = {}; // In-memory cache for ultra-fast performance

io.on('connection', (socket) => {
  // Join a specific board
  socket.on('join-board', (data) => {
    const { boardId, userId } = data;
    socket.join(`board-${boardId}`);
    
    // Load from SQLite if not in memory
    if (!boardStates[boardId]) {
      const row = db.prepare('SELECT * FROM board_sessions WHERE boardId = ?').get(boardId);
      boardStates[boardId] = row ? JSON.parse(row.boardState) : { slide: 1, drawings: {} };
    }
    
    // Send state immediately
    socket.emit('init-state', boardStates[boardId]);
  });

  // Admin changing slides
  socket.on('change-slide', (data) => {
    if (data.role !== 'admin') return; // Strict Admin-only sync
    boardStates[data.boardId].slide = data.slide;
    socket.to(`board-${data.boardId}`).emit('change-slide', data.slide);
  });

  // Drawings (buffered in memory)
  socket.on('draw-stroke', (data) => {
    const { boardId, slide, stroke } = data;
    if (!boardStates[boardId].drawings[slide]) boardStates[boardId].drawings[slide] = [];
    boardStates[data.boardId].drawings[slide].push(stroke);
    
    // Broadcast to everyone else
    socket.to(`board-${data.boardId}`).emit('draw-stroke', stroke);
  });

  // Save to SQLite periodically or when admin explicitly saves
  socket.on('save-board', (boardId) => {
    const stateStr = JSON.stringify(boardStates[boardId]);
    db.prepare(`
      INSERT INTO board_sessions (sessionId, boardId, boardState, lastUpdated) 
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(sessionId) DO UPDATE SET boardState = ?, lastUpdated = CURRENT_TIMESTAMP
    `).run(`session-${boardId}`, boardId, stateStr, stateStr);
  });
});
```

## 5. PDF Generation Workflow

When the Admin clicks "Export Board":
1. **Frontend:** Captures the visible ink layers using Canvas to PNG (`toDataURL`).
2. **Backend:** Fetches the original background PDF from the local file system (managed by SQLite metadata).
3. **Merging:** Uses `pdf-lib` to overlay the PNG ink strokes onto the original PDF.
4. **Final Page:** Appends the "Thank you for using SmartBoard" page.

```javascript
const { PDFDocument } = require('pdf-lib');
const fs = require('fs');

app.post('/api/export', authenticateAdmin, async (req, res) => {
  const { boardId, slideDrawings } = req.body;
  
  // 1. Get original PDF path from SQLite
  const fileRecord = db.prepare('SELECT fileName FROM files WHERE boardId = ? ORDER BY uploadedAt DESC LIMIT 1').get(boardId);
  if (!fileRecord) return res.status(404).send('No PDF found');
  
  const originalPdfBytes = fs.readFileSync(`./data/uploads/${fileRecord.fileName}`);
  const pdfDoc = await PDFDocument.load(originalPdfBytes);
  const pages = pdfDoc.getPages();

  // 2. Overlay client drawings
  for (let i = 0; i < pages.length; i++) {
    if (slideDrawings[i + 1]) {
      const pngImageBytes = Buffer.from(slideDrawings[i + 1].split(',')[1], 'base64');
      const pngImage = await pdfDoc.embedPng(pngImageBytes);
      pages[i].drawImage(pngImage, { x: 0, y: 0, width: pages[i].getWidth(), height: pages[i].getHeight() });
    }
  }

  // 3. Add Final Thank You Page
  const finalPage = pdfDoc.addPage();
  finalPage.drawText('Thank you for using SmartBoard', { x: 50, y: 700, size: 24 });

  // 4. Save Exported File locally
  const exportName = `exported-${Date.now()}.pdf`;
  fs.writeFileSync(`./data/exports/${exportName}`, await pdfDoc.save());

  res.json({ filename: exportName });
});
```

## 6. QR Download Flow

Instead of opening a new webpage, the QR code triggers a direct file download.

```javascript
const QRCode = require('qrcode');

// Generate QR Code for the specific exported file
app.get('/api/qr/:filename', authenticateAdmin, async (req, res) => {
  const downloadUrl = `${process.env.FRONTEND_URL}/api/download/${req.params.filename}`;
  const qrDataUrl = await QRCode.toDataURL(downloadUrl);
  res.json({ qrCode: qrDataUrl, url: downloadUrl });
});

// Force direct download
app.get('/api/download/:filename', (req, res) => {
  const filePath = `./data/exports/${req.params.filename}`;
  // Content-Disposition: attachment forces a download rather than displaying inline
  res.download(filePath, 'SmartBoard-Session.pdf'); 
});
```

## 7. Security Flow (Admin vs User Separation)

1. **Persistent Session (JWT):** 
   - Upon login, both Admins and Users receive a JWT stored in local storage.
   - The payload contains their `role` (`{ id: '...', role: 'admin' }`).
2. **Frontend UI Locks:** 
   - The UI hides the "Upload", "Clear Board", and "Export" buttons unless `role === 'admin'`.
3. **Backend Safeguards:**
   - Routes like `/api/export` and `/api/upload` are guarded by `authenticateAdmin`.
4. **Socket Locks:**
   - Standard users (`role: 'student'`) are prevented from broadcasting `change-slide` and `clear-board` events. If a student tries to emit a slide change, the server rejects it.
