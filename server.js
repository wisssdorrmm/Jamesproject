require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
require('express-async-errors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');

function getSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (process.env.VERCEL) throw new Error('Set JWT_SECRET in your Vercel environment variables.');
  const file = path.join(__dirname, 'data', '.jwt_secret');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
  const secret = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}
const JWT_SECRET = getSecret();

const app = express();
app.use(express.json({ limit: '200kb' }));
app.use('/api', async (req, res, next) => { await db.ready; next(); });
app.use(express.static(path.join(__dirname, 'public')));

/* ---------- helpers ---------- */

const publicUser = (u) => ({
  id: u.id, full_name: u.full_name, email: u.email, role: u.role,
  active: u.active, created_at: u.created_at,
});
const signToken = (u) => jwt.sign({ id: u.id }, JWT_SECRET, { expiresIn: '7d' });
const clean = (v) => (typeof v === 'string' ? v.trim() : '');
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const ROLES = ['owner', 'teacher', 'student'];
const { get, all, run } = db;

async function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Please log in.' });
  try {
    const { id } = jwt.verify(token, JWT_SECRET);
    const user = await get('SELECT * FROM users WHERE id = ?', id);
    if (!user) return res.status(401).json({ error: 'Account no longer exists.' });
    if (!user.active) return res.status(403).json({ error: 'This account is disabled.' });
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: 'Session expired. Please log in again.' });
  }
}
const requireRole = (...roles) => (req, res, next) =>
  roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'You do not have access to this.' });

const activeOwners = async () => (await get("SELECT COUNT(*) n FROM users WHERE role='owner' AND active=1")).n;

async function canSeeClass(user, cls) {
  if (user.role === 'owner') return true;
  if (user.role === 'teacher') return cls.teacher_id === user.id;
  return !!await get('SELECT 1 FROM enrollments WHERE class_id=? AND student_id=?', cls.id, user.id);
}
const canManageClass = (user, cls) => user.role === 'owner' || (user.role === 'teacher' && cls.teacher_id === user.id);

async function newJoinCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) {
    let code = '';
    for (let i = 0; i < 6; i++) code += chars[crypto.randomInt(chars.length)];
    if (!await get('SELECT 1 FROM classes WHERE join_code = ?', code)) return code;
  }
}

async function createUser({ full_name, email, password, role }) {
  const info = await run('INSERT INTO users (full_name, email, password_hash, role) VALUES (?,?,?,?)',
    full_name, email, bcrypt.hashSync(password, 10), role);
  return await get('SELECT * FROM users WHERE id = ?', info.lastInsertRowid);
}

async function deleteAssignment(id) {
  await run('DELETE FROM submissions WHERE assignment_id = ?', id);
  await run('DELETE FROM assignments WHERE id = ?', id);
}
async function deleteClass(id) {
  await run('DELETE FROM submissions WHERE assignment_id IN (SELECT id FROM assignments WHERE class_id = ?)', id);
  await run('DELETE FROM assignments WHERE class_id = ?', id);
  await run('DELETE FROM announcements WHERE class_id = ?', id);
  await run('DELETE FROM enrollments WHERE class_id = ?', id);
  await run('DELETE FROM classes WHERE id = ?', id);
}
async function deleteUser(id) {
  for (const c of await all('SELECT id FROM classes WHERE teacher_id = ?', id)) await deleteClass(c.id);
  for (const a of await all('SELECT id FROM assignments WHERE teacher_id = ?', id)) await deleteAssignment(a.id);
  await run('DELETE FROM submissions WHERE student_id = ?', id);
  await run('DELETE FROM enrollments WHERE student_id = ?', id);
  await run('DELETE FROM announcements WHERE author_id = ?', id);
  await run('DELETE FROM users WHERE id = ?', id);
}

async function validateNewUser(b) {
  const full_name = clean(b.full_name);
  const email = clean(b.email).toLowerCase();
  const password = typeof b.password === 'string' ? b.password : '';
  if (!full_name) return { error: 'Enter a full name.' };
  if (!isEmail(email)) return { error: 'Enter a valid email address.' };
  if (password.length < 6) return { error: 'Password must be at least 6 characters.' };
  if (await get('SELECT 1 FROM users WHERE email = ?', email)) return { error: 'An account with this email already exists.' };
  return { full_name, email, password };
}

/* ---------- auth ---------- */

app.post('/api/auth/signup', async (req, res) => {
  const v = await validateNewUser(req.body);
  if (v.error) return res.status(v.error.includes('exists') ? 409 : 400).json({ error: v.error });
  // Only pre-approved emails (OWNER_EMAILS) can become owner by signing up.
  const role = db.OWNER_EMAILS.includes(v.email) ? 'owner' : req.body.role === 'teacher' ? 'teacher' : 'student';
  const user = await createUser({ ...v, role });
  res.status(201).json({ token: signToken(user), user: publicUser(user) });
});

app.post('/api/auth/login', async (req, res) => {
  const email = clean(req.body.email).toLowerCase();
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const user = await get('SELECT * FROM users WHERE email = ?', email);
  if (!user || !bcrypt.compareSync(password, user.password_hash))
    return res.status(401).json({ error: 'Incorrect email or password.' });
  if (!user.active) return res.status(403).json({ error: 'This account is disabled. Contact the school owner.' });
  res.json({ token: signToken(user), user: publicUser(user) });
});

app.get('/api/me', auth, async (req, res) => res.json({ user: publicUser(req.user) }));

app.put('/api/me', auth, async (req, res) => {
  const full_name = clean(req.body.full_name);
  if (!full_name) return res.status(400).json({ error: 'Enter your full name.' });
  await run('UPDATE users SET full_name = ? WHERE id = ?', full_name, req.user.id);
  res.json({ user: publicUser(await get('SELECT * FROM users WHERE id = ?', req.user.id)) });
});

app.put('/api/me/password', auth, async (req, res) => {
  const { current, next } = req.body;
  if (typeof current !== 'string' || !bcrypt.compareSync(current, req.user.password_hash))
    return res.status(400).json({ error: 'Current password is incorrect.' });
  if (typeof next !== 'string' || next.length < 6)
    return res.status(400).json({ error: 'New password must be at least 6 characters.' });
  await run('UPDATE users SET password_hash = ? WHERE id = ?', bcrypt.hashSync(next, 10), req.user.id);
  res.json({ ok: true });
});

/* ---------- admin panel (owner only) ---------- */

const admin = [auth, requireRole('owner')];

app.get('/api/admin/users', ...admin, async (req, res) => {
  res.json({ users: await all(`SELECT id, full_name, email, role, active, created_at FROM users ORDER BY
    CASE role WHEN 'owner' THEN 0 WHEN 'teacher' THEN 1 ELSE 2 END, full_name`) });
});

app.post('/api/admin/users', ...admin, async (req, res) => {
  const v = await validateNewUser(req.body);
  if (v.error) return res.status(400).json({ error: v.error });
  const role = ROLES.includes(req.body.role) ? req.body.role : 'student';
  res.status(201).json({ user: publicUser(await createUser({ ...v, role })) });
});

app.put('/api/admin/users/:id/role', ...admin, async (req, res) => {
  const target = await get('SELECT * FROM users WHERE id = ?', req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found.' });
  const role = req.body.role;
  if (!ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role.' });
  if (target.role === 'owner' && role !== 'owner' && target.active && await activeOwners() <= 1)
    return res.status(400).json({ error: 'There must always be at least one active owner.' });
  await run('UPDATE users SET role = ? WHERE id = ?', role, target.id);
  res.json({ user: publicUser(await get('SELECT * FROM users WHERE id = ?', target.id)) });
});

app.put('/api/admin/users/:id/active', ...admin, async (req, res) => {
  const target = await get('SELECT * FROM users WHERE id = ?', req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found.' });
  const active = req.body.active ? 1 : 0;
  if (!active && target.role === 'owner' && await activeOwners() <= 1)
    return res.status(400).json({ error: 'There must always be at least one active owner.' });
  if (!active && target.id === req.user.id) return res.status(400).json({ error: 'You cannot disable your own account.' });
  await run('UPDATE users SET active = ? WHERE id = ?', active, target.id);
  res.json({ user: publicUser(await get('SELECT * FROM users WHERE id = ?', target.id)) });
});

app.post('/api/admin/users/:id/password', ...admin, async (req, res) => {
  const target = await get('SELECT * FROM users WHERE id = ?', req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found.' });
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  await run('UPDATE users SET password_hash = ? WHERE id = ?', bcrypt.hashSync(password, 10), target.id);
  res.json({ ok: true });
});

app.delete('/api/admin/users/:id', ...admin, async (req, res) => {
  const target = await get('SELECT * FROM users WHERE id = ?', req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found.' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account.' });
  if (target.role === 'owner' && target.active && await activeOwners() <= 1)
    return res.status(400).json({ error: 'There must always be at least one active owner.' });
  await deleteUser(target.id);
  res.json({ ok: true });
});

app.get('/api/stats', ...admin, async (req, res) => {
  const n = async (sql) => (await get(sql)).n;
  res.json({
    students: await n("SELECT COUNT(*) n FROM users WHERE role='student'"),
    teachers: await n("SELECT COUNT(*) n FROM users WHERE role='teacher'"),
    owners: await n("SELECT COUNT(*) n FROM users WHERE role='owner'"),
    classes: await n('SELECT COUNT(*) n FROM classes'),
    assignments: await n('SELECT COUNT(*) n FROM assignments'),
    submissions: await n('SELECT COUNT(*) n FROM submissions'),
    ungraded: await n('SELECT COUNT(*) n FROM submissions WHERE score IS NULL'),
  });
});

/* ---------- people lists (teacher view of students) ---------- */

app.get('/api/students', auth, requireRole('owner', 'teacher'), async (req, res) => {
  res.json({ students: await all("SELECT id, full_name, email, role, created_at FROM users WHERE role='student' AND active=1 ORDER BY full_name") });
});

/* ---------- classes ---------- */

const classSelect = `SELECT c.*, u.full_name AS teacher_name,
  (SELECT COUNT(*) FROM enrollments e WHERE e.class_id = c.id) AS student_count
  FROM classes c JOIN users u ON u.id = c.teacher_id`;

app.get('/api/classes', auth, async (req, res) => {
  const u = req.user;
  const rows =
    u.role === 'owner' ? await all(`${classSelect} ORDER BY c.created_at DESC`) :
    u.role === 'teacher' ? await all(`${classSelect} WHERE c.teacher_id = ? ORDER BY c.created_at DESC`, u.id) :
    await all(`${classSelect} WHERE c.id IN (SELECT class_id FROM enrollments WHERE student_id = ?) ORDER BY c.created_at DESC`, u.id);
  if (u.role === 'student') rows.forEach((r) => delete r.join_code);
  res.json({ classes: rows });
});

app.post('/api/classes', auth, requireRole('teacher'), async (req, res) => {
  const name = clean(req.body.name);
  if (!name) return res.status(400).json({ error: 'Give the class a name.' });
  const info = await run('INSERT INTO classes (teacher_id, name, subject, join_code) VALUES (?,?,?,?)',
    req.user.id, name, clean(req.body.subject), await newJoinCode());
  res.status(201).json({ class: await get(`${classSelect} WHERE c.id = ?`, info.lastInsertRowid) });
});

app.post('/api/classes/join', auth, requireRole('student'), async (req, res) => {
  const code = clean(req.body.code).toUpperCase();
  const cls = await get('SELECT * FROM classes WHERE join_code = ?', code);
  if (!cls) return res.status(404).json({ error: 'No class found with that code.' });
  await run('INSERT OR IGNORE INTO enrollments (class_id, student_id) VALUES (?,?)', cls.id, req.user.id);
  res.json({ class: await get(`${classSelect} WHERE c.id = ?`, cls.id) });
});

app.get('/api/classes/:id', auth, async (req, res) => {
  const cls = await get(`${classSelect} WHERE c.id = ?`, req.params.id);
  if (!cls || !await canSeeClass(req.user, cls)) return res.status(404).json({ error: 'Class not found.' });
  const students = await all(`SELECT u.id, u.full_name, u.email, e.created_at AS joined
    FROM enrollments e JOIN users u ON u.id = e.student_id WHERE e.class_id = ? ORDER BY u.full_name`, cls.id);
  if (req.user.role === 'student') delete cls.join_code;
  res.json({ class: cls, students: req.user.role === 'student' ? students.map(({ id, full_name }) => ({ id, full_name })) : students });
});

app.delete('/api/classes/:id', auth, async (req, res) => {
  const cls = await get('SELECT * FROM classes WHERE id = ?', req.params.id);
  if (!cls) return res.status(404).json({ error: 'Class not found.' });
  if (!canManageClass(req.user, cls)) return res.status(403).json({ error: 'You can only delete your own classes.' });
  await deleteClass(cls.id);
  res.json({ ok: true });
});

app.post('/api/classes/:id/leave', auth, requireRole('student'), async (req, res) => {
  await run('DELETE FROM enrollments WHERE class_id = ? AND student_id = ?', req.params.id, req.user.id);
  res.json({ ok: true });
});

app.delete('/api/classes/:id/students/:studentId', auth, async (req, res) => {
  const cls = await get('SELECT * FROM classes WHERE id = ?', req.params.id);
  if (!cls || !canManageClass(req.user, cls)) return res.status(403).json({ error: 'You do not have access to this.' });
  await run('DELETE FROM enrollments WHERE class_id = ? AND student_id = ?', cls.id, req.params.studentId);
  res.json({ ok: true });
});

/* ---------- assignments ---------- */

const assignmentSelect = `SELECT a.id, a.teacher_id, a.class_id, a.title, a.description, a.due_date, a.max_score, a.created_at,
  u.full_name AS teacher_name, c.name AS class_name`;
const assignmentFrom = `FROM assignments a JOIN users u ON u.id = a.teacher_id LEFT JOIN classes c ON c.id = a.class_id`;

app.get('/api/assignments', auth, async (req, res) => {
  const u = req.user;
  const classId = req.query.class_id ? Number(req.query.class_id) : null;
  let rows;
  if (u.role === 'student') {
    rows = await all(`${assignmentSelect}, s.id AS sub_id, s.score AS sub_score, s.feedback AS sub_feedback, s.submitted_at AS sub_at, s.content AS sub_content
      ${assignmentFrom} LEFT JOIN submissions s ON s.assignment_id = a.id AND s.student_id = ?
      WHERE (a.class_id IN (SELECT class_id FROM enrollments WHERE student_id = ?) OR a.class_id IS NULL)
      ${classId ? 'AND a.class_id = ?' : ''} ORDER BY a.created_at DESC, a.id DESC`,
      ...[u.id, u.id].concat(classId ? [classId] : []));
  } else {
    const where = [];
    const p = [];
    if (u.role === 'teacher') { where.push('a.teacher_id = ?'); p.push(u.id); }
    if (classId) { where.push('a.class_id = ?'); p.push(classId); }
    rows = await all(`${assignmentSelect}, (SELECT COUNT(*) FROM submissions s WHERE s.assignment_id = a.id) AS submission_count
      ${assignmentFrom} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY a.created_at DESC, a.id DESC`, ...p);
  }
  res.json({ assignments: rows });
});

app.post('/api/assignments', auth, requireRole('teacher'), async (req, res) => {
  const title = clean(req.body.title);
  const due_date = clean(req.body.due_date) || null;
  const max_score = Number.isInteger(Number(req.body.max_score)) && Number(req.body.max_score) > 0 ? Number(req.body.max_score) : 100;
  const cls = await get('SELECT * FROM classes WHERE id = ?', req.body.class_id);
  if (!cls || cls.teacher_id !== req.user.id) return res.status(400).json({ error: 'Pick one of your classes.' });
  if (!title) return res.status(400).json({ error: 'Give the assignment a title.' });
  if (due_date && !/^\d{4}-\d{2}-\d{2}$/.test(due_date)) return res.status(400).json({ error: 'Due date must look like YYYY-MM-DD.' });
  const info = await run('INSERT INTO assignments (teacher_id, class_id, title, description, due_date, max_score) VALUES (?,?,?,?,?,?)',
    req.user.id, cls.id, title, clean(req.body.description), due_date, max_score);
  res.status(201).json({ assignment: await get(`${assignmentSelect} ${assignmentFrom} WHERE a.id = ?`, info.lastInsertRowid) });
});

app.delete('/api/assignments/:id', auth, requireRole('teacher', 'owner'), async (req, res) => {
  const a = await get('SELECT * FROM assignments WHERE id = ?', req.params.id);
  if (!a) return res.status(404).json({ error: 'Assignment not found.' });
  if (req.user.role === 'teacher' && a.teacher_id !== req.user.id)
    return res.status(403).json({ error: 'You can only delete your own assignments.' });
  await deleteAssignment(a.id);
  res.json({ ok: true });
});

app.get('/api/assignments/:id/submissions', auth, requireRole('teacher', 'owner'), async (req, res) => {
  const a = await get('SELECT * FROM assignments WHERE id = ?', req.params.id);
  if (!a) return res.status(404).json({ error: 'Assignment not found.' });
  if (req.user.role === 'teacher' && a.teacher_id !== req.user.id) return res.status(403).json({ error: 'You do not have access to this.' });
  const rows = await all(`SELECT u.id AS student_id, u.full_name, s.id AS submission_id, s.content, s.submitted_at, s.score, s.feedback
    FROM users u LEFT JOIN submissions s ON s.student_id = u.id AND s.assignment_id = ?
    WHERE u.role = 'student' AND (? IS NULL OR u.id IN (SELECT student_id FROM enrollments WHERE class_id = ?))
    ORDER BY u.full_name`, a.id, a.class_id, a.class_id);
  res.json({ assignment: a, rows });
});

app.post('/api/assignments/:id/submit', auth, requireRole('student'), async (req, res) => {
  const a = await get('SELECT * FROM assignments WHERE id = ?', req.params.id);
  if (!a) return res.status(404).json({ error: 'Assignment not found.' });
  if (a.class_id && !await get('SELECT 1 FROM enrollments WHERE class_id=? AND student_id=?', a.class_id, req.user.id))
    return res.status(403).json({ error: 'Join this class first.' });
  const content = clean(req.body.content);
  if (!content) return res.status(400).json({ error: 'Write your answer before submitting.' });
  const existing = await get('SELECT * FROM submissions WHERE assignment_id=? AND student_id=?', a.id, req.user.id);
  if (existing && existing.score !== null) return res.status(400).json({ error: 'This work is already graded.' });
  if (existing) await run("UPDATE submissions SET content=?, submitted_at=datetime('now') WHERE id=?", content, existing.id);
  else await run('INSERT INTO submissions (assignment_id, student_id, content) VALUES (?,?,?)', a.id, req.user.id, content);
  res.json({ ok: true });
});

app.put('/api/submissions/:id/grade', auth, requireRole('teacher', 'owner'), async (req, res) => {
  const s = await get('SELECT s.*, a.teacher_id, a.max_score FROM submissions s JOIN assignments a ON a.id = s.assignment_id WHERE s.id = ?', req.params.id);
  if (!s) return res.status(404).json({ error: 'Submission not found.' });
  if (req.user.role === 'teacher' && s.teacher_id !== req.user.id) return res.status(403).json({ error: 'You do not have access to this.' });
  const score = Number(req.body.score);
  if (!Number.isInteger(score) || score < 0 || score > s.max_score)
    return res.status(400).json({ error: `Score must be a whole number from 0 to ${s.max_score}.` });
  await run("UPDATE submissions SET score=?, feedback=?, graded_at=datetime('now') WHERE id=?", score, clean(req.body.feedback), s.id);
  res.json({ ok: true });
});

/* ---------- announcements ---------- */

const annSelect = `SELECT n.id, n.author_id, n.class_id, n.title, n.body, n.created_at,
  u.full_name AS author_name, c.name AS class_name
  FROM announcements n JOIN users u ON u.id = n.author_id LEFT JOIN classes c ON c.id = n.class_id`;

app.get('/api/announcements', auth, async (req, res) => {
  const u = req.user;
  const classId = req.query.class_id ? Number(req.query.class_id) : null;
  let rows;
  if (classId) {
    const cls = await get('SELECT * FROM classes WHERE id = ?', classId);
    if (!cls || !await canSeeClass(u, cls)) return res.status(404).json({ error: 'Class not found.' });
    rows = await all(`${annSelect} WHERE n.class_id = ? ORDER BY n.created_at DESC, n.id DESC`, classId);
  } else if (u.role === 'owner') rows = await all(`${annSelect} ORDER BY n.created_at DESC, n.id DESC LIMIT 100`);
  else if (u.role === 'teacher')
    rows = await all(`${annSelect} WHERE n.class_id IS NULL OR c.teacher_id = ? ORDER BY n.created_at DESC, n.id DESC LIMIT 100`, u.id);
  else
    rows = await all(`${annSelect} WHERE n.class_id IS NULL OR n.class_id IN (SELECT class_id FROM enrollments WHERE student_id = ?)
      ORDER BY n.created_at DESC, n.id DESC LIMIT 100`, u.id);
  res.json({ announcements: rows });
});

app.post('/api/announcements', auth, requireRole('owner', 'teacher'), async (req, res) => {
  const title = clean(req.body.title);
  if (!title) return res.status(400).json({ error: 'Give the announcement a title.' });
  let class_id = req.body.class_id ? Number(req.body.class_id) : null;
  if (class_id) {
    const cls = await get('SELECT * FROM classes WHERE id = ?', class_id);
    if (!cls || !canManageClass(req.user, cls)) return res.status(400).json({ error: 'Pick one of your classes.' });
  } else if (req.user.role !== 'owner') {
    return res.status(400).json({ error: 'Pick a class for this announcement.' });
  }
  const info = await run('INSERT INTO announcements (author_id, class_id, title, body) VALUES (?,?,?,?)',
    req.user.id, class_id, title, clean(req.body.body));
  res.status(201).json({ announcement: await get(`${annSelect} WHERE n.id = ?`, info.lastInsertRowid) });
});

app.delete('/api/announcements/:id', auth, requireRole('owner', 'teacher'), async (req, res) => {
  const n = await get('SELECT * FROM announcements WHERE id = ?', req.params.id);
  if (!n) return res.status(404).json({ error: 'Announcement not found.' });
  if (req.user.role === 'teacher' && n.author_id !== req.user.id) return res.status(403).json({ error: 'You can only delete your own announcements.' });
  await run('DELETE FROM announcements WHERE id = ?', n.id);
  res.json({ ok: true });
});

app.use('/api', async (req, res) => res.status(404).json({ error: 'Not found.' }));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Server error. Please try again.' });
});

module.exports = app;

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`School app running at http://localhost:${PORT}`));
}
