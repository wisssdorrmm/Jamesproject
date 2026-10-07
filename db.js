const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

// Remote (Turso) when TURSO_DATABASE_URL is set, otherwise a local SQLite file for development.
const remote = !!process.env.TURSO_DATABASE_URL;
const { createClient } = remote ? require('@libsql/client/web') : require('@libsql/client');

let url, authToken;
if (remote) {
  url = process.env.TURSO_DATABASE_URL;
  authToken = process.env.TURSO_AUTH_TOKEN;
} else {
  if (process.env.VERCEL) throw new Error('Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN in your Vercel environment variables.');
  const dataDir = path.join(__dirname, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  url = 'file:' + path.join(dataDir, 'school.db');
}
const client = createClient({ url, authToken });

const toObjects = (rs) => rs.rows.map((r) => Object.fromEntries(rs.columns.map((c, i) => [c, r[i]])));
const clean = (args) => args.map((a) => (a === undefined ? null : a));
const get = async (sql, ...args) => toObjects(await client.execute({ sql, args: clean(args) }))[0];
const all = async (sql, ...args) => toObjects(await client.execute({ sql, args: clean(args) }));
const run = async (sql, ...args) => {
  const r = await client.execute({ sql, args: clean(args) });
  return { changes: r.rowsAffected, lastInsertRowid: Number(r.lastInsertRowid) };
};

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('owner','teacher','student')),
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS classes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    teacher_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    subject TEXT,
    join_code TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS enrollments (
    class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
    student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (class_id, student_id)
  )`,
  `CREATE TABLE IF NOT EXISTS assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    teacher_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    class_id INTEGER REFERENCES classes(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT,
    due_date TEXT,
    max_score INTEGER NOT NULL DEFAULT 100,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    assignment_id INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
    student_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    submitted_at TEXT NOT NULL DEFAULT (datetime('now')),
    score INTEGER,
    feedback TEXT,
    graded_at TEXT,
    UNIQUE (assignment_id, student_id)
  )`,
  `CREATE TABLE IF NOT EXISTS announcements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    class_id INTEGER REFERENCES classes(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    body TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
];

// Emails that automatically become owner (on signup, and on every start if the account already exists)
const OWNER_EMAILS = (process.env.OWNER_EMAILS || 'wisdomudoudo24@gmail.com')
  .split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);

async function init() {
  await client.batch(SCHEMA, 'write');

  // Upgrade databases created by older versions of the app
  const cols = async (t) => (await all(`PRAGMA table_info(${t})`)).map((c) => c.name);
  if (!(await cols('users')).includes('active'))
    await run('ALTER TABLE users ADD COLUMN active INTEGER NOT NULL DEFAULT 1');
  const ac = await cols('assignments');
  if (!ac.includes('class_id')) await run('ALTER TABLE assignments ADD COLUMN class_id INTEGER REFERENCES classes(id) ON DELETE CASCADE');
  if (!ac.includes('max_score')) await run('ALTER TABLE assignments ADD COLUMN max_score INTEGER NOT NULL DEFAULT 100');

  if (OWNER_EMAILS.length)
    await run(`UPDATE users SET role = 'owner' WHERE role != 'owner' AND lower(email) IN (${OWNER_EMAILS.map(() => '?').join(',')})`, ...OWNER_EMAILS);

  // Optional: seed an owner with a password (only when OWNER_PASSWORD is set and no owner exists)
  if (process.env.OWNER_EMAIL && process.env.OWNER_PASSWORD && !(await get("SELECT 1 AS x FROM users WHERE role = 'owner'"))) {
    await run("INSERT INTO users (full_name, email, password_hash, role) VALUES (?, ?, ?, 'owner')",
      process.env.OWNER_NAME || 'School Owner', process.env.OWNER_EMAIL.toLowerCase(), bcrypt.hashSync(process.env.OWNER_PASSWORD, 10));
    console.log(`Owner account created -> ${process.env.OWNER_EMAIL}`);
  }
}

module.exports = { get, all, run, client, OWNER_EMAILS, ready: init() };
