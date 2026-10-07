require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');

// JWT secret: from .env, otherwise generated once and stored in data/
function getSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const file = path.join(__dirname, 'data', '.jwt_secret');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
  const secret = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}
const JWT_SECRET = getSecret();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ---------- helpers ---------- */

const publicUser = (u) => ({
  id: u.id,
  full_name: u.full_name,
  email: u.email,
  role: u.role,
  created_at: u.created_at,
});

const signToken = (user) =>
  jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '7d' });

function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Please log in.' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.id);
    if (!user) return res.status(401).json({ error: 'Account no longer exists.' });
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: 'Session expired. Please log in again.' });
  }
}

const requireRole = (...roles) => (req, res, next) =>
  roles.includes(req.user.role)
    ? next()
    : res.status(403).json({ error: 'You do not have access to this.' });

const clean = (v) => (typeof v === 'string' ? v.trim() : '');
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

/* ---------- auth ---------- */

// Public signup: teacher or student only. Owner can never be self-assigned.
app.post('/api/auth/signup', (req, res) => {
  const full_name = clean(req.body.full_name);
  const email = clean(req.body.email).toLowerCase();
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const role = req.body.role === 'teacher' ? 'teacher' : 'student';

  if (!full_name) return res.status(400).json({ error: 'Enter your full name.' });
  if (!isEmail(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });

  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
    return res.status(409).json({ error: 'An account with this email already exists.' });
  }

  const info = db
    .prepare('INSERT INTO users (full_name, email, password_hash, role) VALUES (?, ?, ?, ?)')
    .run(full_name, email, bcrypt.hashSync(password, 10), role);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ token: signToken(user), user: publicUser(user) });
});

app.post('/api/auth/login', (req, res) => {
  const email = clean(req.body.email).toLowerCase();
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }
  res.json({ token: signToken(user), user: publicUser(user) });
});

app.get('/api/me', auth, (req, res) => res.json({ user: publicUser(req.user) }));

/* ---------- people ---------- */

app.get('/api/students', auth, requireRole('owner', 'teacher'), (req, res) => {
  const rows = db
    .prepare("SELECT id, full_name, email, role, created_at FROM users WHERE role = 'student' ORDER BY full_name")
    .all();
  res.json({ students: rows });
});

app.get('/api/teachers', auth, requireRole('owner'), (req, res) => {
  const rows = db
    .prepare(
      `SELECT u.id, u.full_name, u.email, u.role, u.created_at,
              (SELECT COUNT(*) FROM assignments a WHERE a.teacher_id = u.id) AS assignment_count
       FROM users u WHERE u.role = 'teacher' ORDER BY u.full_name`
    )
    .all();
  res.json({ teachers: rows });
});

app.delete('/api/users/:id', auth, requireRole('owner'), (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found.' });
  if (target.role === 'owner') return res.status(400).json({ error: 'The owner account cannot be removed.' });
  db.prepare('DELETE FROM users WHERE id = ?').run(target.id);
  res.json({ ok: true });
});

/* ---------- assignments ---------- */

const assignmentSelect = `
  SELECT a.id, a.teacher_id, a.title, a.description, a.due_date, a.created_at,
         u.full_name AS teacher_name
  FROM assignments a JOIN users u ON u.id = a.teacher_id`;

app.get('/api/assignments', auth, (req, res) => {
  const rows = db.prepare(`${assignmentSelect} ORDER BY a.created_at DESC, a.id DESC`).all();
  res.json({ assignments: rows });
});

app.post('/api/assignments', auth, requireRole('teacher'), (req, res) => {
  const title = clean(req.body.title);
  const description = clean(req.body.description);
  const due_date = clean(req.body.due_date) || null;
  if (!title) return res.status(400).json({ error: 'Give the assignment a title.' });
  if (due_date && !/^\d{4}-\d{2}-\d{2}$/.test(due_date)) {
    return res.status(400).json({ error: 'Due date must look like YYYY-MM-DD.' });
  }
  const info = db
    .prepare('INSERT INTO assignments (teacher_id, title, description, due_date) VALUES (?, ?, ?, ?)')
    .run(req.user.id, title, description, due_date);
  const row = db.prepare(`${assignmentSelect} WHERE a.id = ?`).get(info.lastInsertRowid);
  res.status(201).json({ assignment: row });
});

app.put('/api/assignments/:id', auth, requireRole('teacher'), (req, res) => {
  const existing = db.prepare('SELECT * FROM assignments WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Assignment not found.' });
  if (existing.teacher_id !== req.user.id) {
    return res.status(403).json({ error: 'You can only edit your own assignments.' });
  }
  const title = clean(req.body.title) || existing.title;
  const description = req.body.description !== undefined ? clean(req.body.description) : existing.description;
  const due_date = req.body.due_date !== undefined ? clean(req.body.due_date) || null : existing.due_date;
  db.prepare('UPDATE assignments SET title = ?, description = ?, due_date = ? WHERE id = ?').run(
    title, description, due_date, existing.id
  );
  res.json({ assignment: db.prepare(`${assignmentSelect} WHERE a.id = ?`).get(existing.id) });
});

app.delete('/api/assignments/:id', auth, requireRole('teacher', 'owner'), (req, res) => {
  const existing = db.prepare('SELECT * FROM assignments WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Assignment not found.' });
  if (req.user.role === 'teacher' && existing.teacher_id !== req.user.id) {
    return res.status(403).json({ error: 'You can only delete your own assignments.' });
  }
  db.prepare('DELETE FROM assignments WHERE id = ?').run(existing.id);
  res.json({ ok: true });
});

/* ---------- owner overview ---------- */

app.get('/api/stats', auth, requireRole('owner'), (req, res) => {
  const count = (sql) => db.prepare(sql).get().n;
  res.json({
    students: count("SELECT COUNT(*) AS n FROM users WHERE role = 'student'"),
    teachers: count("SELECT COUNT(*) AS n FROM users WHERE role = 'teacher'"),
    assignments: count('SELECT COUNT(*) AS n FROM assignments'),
  });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`School app running at http://localhost:${PORT}`));
