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
  // Add rich student data blob column (stores interests, skills, goals, etc. as JSON)
  "ALTER TABLE cdp_students ADD COLUMN student_data_json TEXT",
];
for (const sql of migrations) {
  try { db.prepare(sql).run(); } catch { /* column may already exist */ }
}

module.exports = db;
