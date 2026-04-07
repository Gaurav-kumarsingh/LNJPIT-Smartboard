const express = require('express');
const Database = require('better-sqlite3');
const multer = require('multer');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(cors());
// Serve frontend files from public folder
app.use(express.static(path.join(__dirname, 'public')));

// Ensure uploads directory exists
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
// Serve uploaded PDFs
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const db = new Database('./database.sqlite');
// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');

const SECRET_KEY = process.env.JWT_SECRET || 'super_secret_jwt_key_infi_pdf';

// Initialize tables
db.exec(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE,
    password TEXT
)`);

db.exec(`CREATE TABLE IF NOT EXISTS boards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    subject TEXT,
    user_id INTEGER,
    FOREIGN KEY (user_id) REFERENCES users(id)
)`);

// Safe addition if subject column wasn't there
try { db.exec('ALTER TABLE boards ADD COLUMN subject TEXT'); } catch(e) { /* column already exists */ }

db.exec(`CREATE TABLE IF NOT EXISTS pdfs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT,
    original_name TEXT,
    board_id INTEGER,
    FOREIGN KEY (board_id) REFERENCES boards(id)
)`);

// Configure Multer for PDF upload
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + file.originalname);
    }
});
const upload = multer({ storage });

// Middleware for verifying JWT
const authenticate = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });

    jwt.verify(token, SECRET_KEY, (err, user) => {
        if (err) return res.status(403).json({ error: 'Invalid token' });
        req.user = user;
        next();
    });
};

// Prepare statements for performance
const insertUser = db.prepare('INSERT INTO users (email, password) VALUES (?, ?)');
const getUserByEmail = db.prepare('SELECT * FROM users WHERE email = ?');
const getAllBoards = db.prepare('SELECT * FROM boards');
const insertBoard = db.prepare('INSERT INTO boards (name, subject, user_id) VALUES (?, ?, ?)');
const deleteBoard = db.prepare('DELETE FROM boards WHERE id = ?');
const getPdfsByBoard = db.prepare('SELECT * FROM pdfs WHERE board_id = ?');
const deletePdfsByBoard = db.prepare('DELETE FROM pdfs WHERE board_id = ?');
const updateBoardName = db.prepare('UPDATE boards SET name = ? WHERE id = ?');
const insertPdf = db.prepare('INSERT INTO pdfs (filename, original_name, board_id) VALUES (?, ?, ?)');

app.post('/api/register', async (req, res) => {
    try {
        const { email, password } = req.body;
        const hash = await bcrypt.hash(password, 10);
        const result = insertUser.run(email, hash);
        res.json({ id: result.lastInsertRowid, email });
    } catch (err) {
        res.status(400).json({ error: 'Email already exists' });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const user = getUserByEmail.get(email);
        if (!user) return res.status(400).json({ error: 'User not found' });

        const match = await bcrypt.compare(password, user.password);
        if (!match) return res.status(401).json({ error: 'Incorrect password' });

        const token = jwt.sign({ id: user.id, email: user.email }, SECRET_KEY);
        res.json({ token, email: user.email });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/boards', (req, res) => {
    try {
        const rows = getAllBoards.all();
        res.json(rows || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/boards', authenticate, (req, res) => {
    try {
        const { name, subject } = req.body;
        const result = insertBoard.run(name, subject || 'General', req.user.id);
        res.json({ id: result.lastInsertRowid, name, subject: subject || 'General' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/boards/:id', authenticate, (req, res) => {
    try {
        const result = deleteBoard.run(req.params.id);
        if (result.changes === 0) return res.status(404).json({ error: 'Board not found or unauthorized' });

        // cascade delete pdfs locally
        const rows = getPdfsByBoard.all(req.params.id);
        if (rows) {
            rows.forEach(r => {
                const fp = path.join(__dirname, 'uploads', r.filename);
                if (fs.existsSync(fp)) fs.unlinkSync(fp);
            });
            deletePdfsByBoard.run(req.params.id);
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/boards/:id', authenticate, (req, res) => {
    try {
        const { name } = req.body;
        const result = updateBoardName.run(name, req.params.id);
        if (result.changes === 0) return res.status(404).json({ error: 'Board not found' });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/boards/:id/pdfs', (req, res) => {
    try {
        const rows = getPdfsByBoard.all(req.params.id);
        res.json(rows || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/upload', authenticate, upload.single('pdf'), (req, res) => {
    try {
        const { board_id } = req.body;
        if (!req.file || !board_id) return res.status(400).json({ error: 'File and board_id required' });

        const result = insertPdf.run(req.file.filename, req.file.originalname, board_id);
        res.json({ id: result.lastInsertRowid, filename: req.file.filename, original_name: req.file.originalname });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
