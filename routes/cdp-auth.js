'use strict';

const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const { v4: uuidv4 } = require('uuid');
const db = require('../db/database');

const router = express.Router();
const JWT_SECRET = process.env.CDP_JWT_SECRET || 'dev-secret-change-in-prod';
const SALT_ROUNDS = 12;

// ── Middleware ──────────────────────────────────────────────

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    req.student = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ── POST /auth/register ─────────────────────────────────────

router.post('/auth/register', [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
  body('firstName').trim().notEmpty().withMessage('First name required'),
  body('lastName').trim().notEmpty().withMessage('Last name required'),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { email, password, firstName, lastName, school, graduationYear, major } = req.body;

  const existing = db.prepare('SELECT id FROM cdp_students WHERE email = ?').get(email);
  if (existing) return res.status(409).json({ error: 'Email already registered' });

  const uid = uuidv4();
  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  db.prepare(`
    INSERT INTO cdp_students (uid, email, password_hash, first_name, last_name, school, graduation_year, major)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(uid, email, passwordHash, firstName, lastName, school || null, graduationYear || null, major || null);

  const token = jwt.sign({ uid, email }, JWT_SECRET, { expiresIn: '30d' });
  res.status(201).json({ uid, email, firstName, lastName, token });
});

// ── POST /auth/login ────────────────────────────────────────

router.post('/auth/login', [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { email, password } = req.body;
  const student = db.prepare('SELECT * FROM cdp_students WHERE email = ?').get(email);
  if (!student) return res.status(401).json({ error: 'Invalid credentials' });

  const valid = await bcrypt.compare(password, student.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

  const token = jwt.sign({ uid: student.uid, email: student.email }, JWT_SECRET, { expiresIn: '30d' });
  res.json({
    uid: student.uid,
    email: student.email,
    firstName: student.first_name,
    lastName: student.last_name,
    token
  });
});

// ── GET /auth/me ────────────────────────────────────────────

router.get('/auth/me', authMiddleware, (req, res) => {
  const student = db.prepare(
    'SELECT uid, email, first_name, last_name, school, graduation_year, major, bio, linkedin_url, created_at FROM cdp_students WHERE uid = ?'
  ).get(req.student.uid);
  if (!student) return res.status(404).json({ error: 'Student not found' });
  res.json(student);
});

module.exports = router;
module.exports.authMiddleware = authMiddleware;
