'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'lablink.db');
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

// Ensure data directory exists
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

// Apply schema on startup
const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
db.exec(schema);

// Migrations — safe to run repeatedly (IF NOT EXISTS / try-catch)
const migrations = [
  "ALTER TABLE cdp_students ADD COLUMN student_data_json TEXT",
  "ALTER TABLE cdp_programs ADD COLUMN sector TEXT",
  "ALTER TABLE cdp_programs ADD COLUMN categories TEXT",
  "ALTER TABLE cdp_students ADD COLUMN google_id TEXT",
  // Indexes for frequently queried columns
  "CREATE INDEX IF NOT EXISTS idx_cdp_students_uid ON cdp_students(uid)",
  "CREATE INDEX IF NOT EXISTS idx_cdp_students_email ON cdp_students(email)",
  "CREATE INDEX IF NOT EXISTS idx_cdp_programs_slug ON cdp_programs(slug)",
  "CREATE INDEX IF NOT EXISTS idx_cdp_programs_sector ON cdp_programs(sector)",
  "CREATE INDEX IF NOT EXISTS idx_cdp_programs_active ON cdp_programs(is_active)",
  "CREATE INDEX IF NOT EXISTS idx_cdp_saved_student ON cdp_saved_programs(student_id)",
  "CREATE INDEX IF NOT EXISTS idx_cdp_gap_student ON cdp_gap_analyses(student_id)",
];
for (const sql of migrations) {
  try { db.prepare(sql).run(); } catch { /* column may already exist */ }
}

module.exports = db;
