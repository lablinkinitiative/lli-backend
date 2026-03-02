'use strict';

const express = require('express');
const { body, validationResult } = require('express-validator');
const db = require('../db/database');
const { authMiddleware } = require('./cdp-auth');

const router = express.Router();

// ── GET /students/me/profile ────────────────────────────────

router.get('/students/me/profile', authMiddleware, (req, res) => {
  const student = db.prepare(
    'SELECT uid, email, first_name, last_name, school, graduation_year, major, bio, linkedin_url, created_at, updated_at FROM cdp_students WHERE uid = ?'
  ).get(req.student.uid);
  if (!student) return res.status(404).json({ error: 'Student not found' });
  res.json(student);
});

// ── PUT /students/me/profile ────────────────────────────────

router.put('/students/me/profile', authMiddleware, [
  body('firstName').optional().trim().notEmpty(),
  body('lastName').optional().trim().notEmpty(),
  body('school').optional().trim(),
  body('graduationYear').optional().isInt({ min: 2020, max: 2035 }),
  body('major').optional().trim(),
  body('bio').optional().trim().isLength({ max: 1000 }),
  body('linkedinUrl').optional().isURL(),
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { firstName, lastName, school, graduationYear, major, bio, linkedinUrl } = req.body;

  db.prepare(`
    UPDATE cdp_students SET
      first_name     = COALESCE(?, first_name),
      last_name      = COALESCE(?, last_name),
      school         = COALESCE(?, school),
      graduation_year = COALESCE(?, graduation_year),
      major          = COALESCE(?, major),
      bio            = COALESCE(?, bio),
      linkedin_url   = COALESCE(?, linkedin_url),
      updated_at     = datetime('now')
    WHERE uid = ?
  `).run(
    firstName || null, lastName || null, school || null,
    graduationYear || null, major || null, bio || null,
    linkedinUrl || null, req.student.uid
  );

  const updated = db.prepare(
    'SELECT uid, email, first_name, last_name, school, graduation_year, major, bio, linkedin_url, updated_at FROM cdp_students WHERE uid = ?'
  ).get(req.student.uid);
  res.json(updated);
});

// ── GET /programs ───────────────────────────────────────────

router.get('/programs', (req, res) => {
  const { type, field, q } = req.query;
  let sql = 'SELECT * FROM cdp_programs WHERE is_active = 1';
  const params = [];

  if (type) { sql += ' AND program_type = ?'; params.push(type); }
  if (field) { sql += ' AND stem_fields LIKE ?'; params.push(`%${field}%`); }
  if (q) { sql += ' AND (title LIKE ? OR organization LIKE ? OR description LIKE ?)'; params.push(`%${q}%`, `%${q}%`, `%${q}%`); }

  sql += ' ORDER BY created_at DESC';
  const programs = db.prepare(sql).all(...params);
  res.json({ programs, total: programs.length });
});

// ── GET /programs/:slug ─────────────────────────────────────

router.get('/programs/:slug', (req, res) => {
  const program = db.prepare('SELECT * FROM cdp_programs WHERE slug = ? AND is_active = 1').get(req.params.slug);
  if (!program) return res.status(404).json({ error: 'Program not found' });
  res.json(program);
});

// ── GET /students/me/saved-programs ────────────────────────

router.get('/students/me/saved-programs', authMiddleware, (req, res) => {
  const student = db.prepare('SELECT id FROM cdp_students WHERE uid = ?').get(req.student.uid);
  if (!student) return res.status(404).json({ error: 'Student not found' });

  const saved = db.prepare(`
    SELECT p.*, sp.notes, sp.saved_at
    FROM cdp_saved_programs sp
    JOIN cdp_programs p ON p.id = sp.program_id
    WHERE sp.student_id = ?
    ORDER BY sp.saved_at DESC
  `).all(student.id);
  res.json({ saved, total: saved.length });
});

// ── POST /students/me/saved-programs/:programId ─────────────

router.post('/students/me/saved-programs/:programId', authMiddleware, (req, res) => {
  const student = db.prepare('SELECT id FROM cdp_students WHERE uid = ?').get(req.student.uid);
  if (!student) return res.status(404).json({ error: 'Student not found' });

  const program = db.prepare('SELECT id FROM cdp_programs WHERE id = ?').get(req.params.programId);
  if (!program) return res.status(404).json({ error: 'Program not found' });

  try {
    db.prepare(
      'INSERT INTO cdp_saved_programs (student_id, program_id, notes) VALUES (?, ?, ?)'
    ).run(student.id, program.id, req.body.notes || null);
    res.status(201).json({ message: 'Program saved' });
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(409).json({ error: 'Already saved' });
    throw err;
  }
});

// ── DELETE /students/me/saved-programs/:programId ──────────

router.delete('/students/me/saved-programs/:programId', authMiddleware, (req, res) => {
  const student = db.prepare('SELECT id FROM cdp_students WHERE uid = ?').get(req.student.uid);
  if (!student) return res.status(404).json({ error: 'Student not found' });

  db.prepare('DELETE FROM cdp_saved_programs WHERE student_id = ? AND program_id = ?')
    .run(student.id, req.params.programId);
  res.json({ message: 'Removed from saved programs' });
});

// ── GET /students/me/gap-analyses ──────────────────────────

router.get('/students/me/gap-analyses', authMiddleware, (req, res) => {
  const student = db.prepare('SELECT id FROM cdp_students WHERE uid = ?').get(req.student.uid);
  if (!student) return res.status(404).json({ error: 'Student not found' });

  const analyses = db.prepare(`
    SELECT ga.*, p.title as program_title, p.organization
    FROM cdp_gap_analyses ga
    LEFT JOIN cdp_programs p ON p.id = ga.program_id
    WHERE ga.student_id = ?
    ORDER BY ga.generated_at DESC
  `).all(student.id);
  res.json({ analyses, total: analyses.length });
});

// ── POST /students/me/gap-analyses ─────────────────────────

router.post('/students/me/gap-analyses', authMiddleware, [
  body('programId').optional().isInt(),
  body('readinessScore').optional().isInt({ min: 0, max: 100 }),
  body('strengths').optional().isArray(),
  body('gaps').optional().isArray(),
  body('recommendations').optional().isArray(),
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const student = db.prepare('SELECT id FROM cdp_students WHERE uid = ?').get(req.student.uid);
  if (!student) return res.status(404).json({ error: 'Student not found' });

  const { programId, readinessScore, strengths, gaps, recommendations } = req.body;

  const result = db.prepare(`
    INSERT INTO cdp_gap_analyses (student_id, program_id, readiness_score, strengths, gaps, recommendations)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    student.id,
    programId || null,
    readinessScore || null,
    strengths ? JSON.stringify(strengths) : null,
    gaps ? JSON.stringify(gaps) : null,
    recommendations ? JSON.stringify(recommendations) : null
  );

  const analysis = db.prepare('SELECT * FROM cdp_gap_analyses WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(analysis);
});

module.exports = router;
