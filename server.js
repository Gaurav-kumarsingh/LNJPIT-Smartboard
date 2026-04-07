const express = require('express');
const sqlite3 = require('sqlite3').verbose();
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

const db = new sqlite3.Database('./database.sqlite');
const SECRET_KEY = process.env.JWT_SECRET || 'super_secret_jwt_key_infi_pdf';

// Initialize tables
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE,
        password TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS boards (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        subject TEXT,
        user_id INTEGER,
        FOREIGN KEY (user_id) REFERENCES users(id)
    )`, (err) => {
        // Safe addition if subject column wasn't there
        db.run('ALTER TABLE boards ADD COLUMN subject TEXT', () => {});
    });

    db.run(`CREATE TABLE IF NOT EXISTS pdfs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        filename TEXT,
        original_name TEXT,
        board_id INTEGER,
        FOREIGN KEY (board_id) REFERENCES boards(id)
    )`);
});

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

app.post('/api/register', (req, res) => {
    const { email, password } = req.body;
    bcrypt.hash(password, 10, (err, hash) => {
        if (err) return res.status(500).json({ error: err.message });
        db.run('INSERT INTO users (email, password) VALUES (?, ?)', [email, hash], function(err) {
            if (err) return res.status(400).json({ error: 'Email already exists' });
            res.json({ id: this.lastID, email });
        });
    });
});

app.post('/api/login', (req, res) => {
    const { email, password } = req.body;
    db.get('SELECT * FROM users WHERE email = ?', [email], (err, user) => {
        if (err || !user) return res.status(400).json({ error: 'User not found' });
        bcrypt.compare(password, user.password, (err, match) => {
            if (!match) return res.status(401).json({ error: 'Incorrect password' });
            const token = jwt.sign({ id: user.id, email: user.email }, SECRET_KEY);
            res.json({ token, email: user.email });
        });
    });
});

app.get('/api/boards', (req, res) => {
    db.all('SELECT * FROM boards', [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
    });
});

app.post('/api/boards', authenticate, (req, res) => {
    const { name, subject } = req.body;
    db.run('INSERT INTO boards (name, subject, user_id) VALUES (?, ?, ?)', [name, subject || 'General', req.user.id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ id: this.lastID, name, subject: subject || 'General' });
    });
});

app.delete('/api/boards/:id', authenticate, (req, res) => {
    db.run('DELETE FROM boards WHERE id = ?', [req.params.id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes === 0) return res.status(404).json({ error: 'Board not found or unauthorized' });
        
        // cascade delete pdfs locally
        db.all('SELECT filename FROM pdfs WHERE board_id = ?', [req.params.id], (err, rows) => {
            if (rows) {
                rows.forEach(r => {
                    const fp = path.join(__dirname, 'uploads', r.filename);
                    if (fs.existsSync(fp)) fs.unlinkSync(fp);
                });
                db.run('DELETE FROM pdfs WHERE board_id = ?', [req.params.id]);
            }
        });
        res.json({ success: true });
    });
});

app.put('/api/boards/:id', authenticate, (req, res) => {
    const { name } = req.body;
    db.run('UPDATE boards SET name = ? WHERE id = ?', [name, req.params.id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes === 0) return res.status(404).json({ error: 'Board not found' });
        res.json({ success: true });
    });
});

app.get('/api/boards/:id/pdfs', (req, res) => {
    db.all('SELECT * FROM pdfs WHERE board_id = ?', [req.params.id], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows || []);
    });
});

app.post('/api/upload', authenticate, upload.single('pdf'), (req, res) => {
    const { board_id } = req.body;
    if (!req.file || !board_id) return res.status(400).json({ error: 'File and board_id required' });

    db.run('INSERT INTO pdfs (filename, original_name, board_id) VALUES (?, ?, ?)', 
        [req.file.filename, req.file.originalname, board_id], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ id: this.lastID, filename: req.file.filename, original_name: req.file.originalname });
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
