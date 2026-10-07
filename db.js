const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const dataDir = path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'school.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    full_name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('owner','teacher','student')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    teacher_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT,
    due_date TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Seed the owner account on first run
const ownerExists = db.prepare("SELECT 1 FROM users WHERE role = 'owner'").get();
if (!ownerExists) {
  const email = process.env.OWNER_EMAIL || 'owner@school.local';
  const password = process.env.OWNER_PASSWORD || 'ChangeMe123!';
  const name = process.env.OWNER_NAME || 'School Owner';
  db.prepare(
    "INSERT INTO users (full_name, email, password_hash, role) VALUES (?, ?, ?, 'owner')"
  ).run(name, email, bcrypt.hashSync(password, 10));
  console.log(`Owner account created -> ${email}`);
  if (!process.env.OWNER_PASSWORD) {
    console.log('WARNING: using the default owner password. Set OWNER_PASSWORD in .env and delete data/school.db to re-seed.');
  }
}

module.exports = db;
