'use strict';

const express = require('express');
const router = express.Router();
const db = require('../db/database');

// GET /api/waitlist — list waitlist entries
router.get('/', (req, res) => {
  const { equipment_id, user_email, status } = req.query;
  let sql = `
    SELECT w.*, e.name AS equipment_name
    FROM waitlist w
    JOIN equipment e ON w.equipment_id = e.id
    WHERE 1=1
  `;
  const params = [];
  if (equipment_id) { sql += ' AND w.equipment_id = ?'; params.push(equipment_id); }
  if (user_email)   { sql += ' AND w.user_email = ?'; params.push(user_email); }
  if (status)       { sql += ' AND w.status = ?'; params.push(status); }
  sql += ' ORDER BY w.created_at ASC';
  res.json(db.prepare(sql).all(...params));
});

// GET /api/waitlist/:id — single entry
router.get('/:id', (req, res) => {
  const row = db.prepare(`
    SELECT w.*, e.name AS equipment_name
    FROM waitlist w
    JOIN equipment e ON w.equipment_id = e.id
    WHERE w.id = ?
  `).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Waitlist entry not found' });
  res.json(row);
});

// POST /api/waitlist — add to waitlist
router.post('/', (req, res) => {
  const { equipment_id, user_name, user_email, lab_slug, requested_start, requested_end, purpose } = req.body;
  if (!equipment_id || !user_name || !user_email || !lab_slug || !requested_start || !requested_end) {
    return res.status(400).json({ error: 'equipment_id, user_name, user_email, lab_slug, requested_start, requested_end are required' });
  }
  const result = db.prepare(`
    INSERT INTO waitlist (equipment_id, user_name, user_email, lab_slug, requested_start, requested_end, purpose)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(equipment_id, user_name, user_email, lab_slug, requested_start, requested_end, purpose || null);
  res.status(201).json(db.prepare('SELECT * FROM waitlist WHERE id = ?').get(result.lastInsertRowid));
});

// PATCH /api/waitlist/:id — update status
router.patch('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM waitlist WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Waitlist entry not found' });
  const { status } = req.body;
  const validStatuses = ['waiting', 'notified', 'booked', 'cancelled'];
  if (!status || !validStatuses.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${validStatuses.join(', ')}` });
  }
  db.prepare('UPDATE waitlist SET status = ? WHERE id = ?').run(status, req.params.id);
  res.json(db.prepare('SELECT * FROM waitlist WHERE id = ?').get(req.params.id));
});

// DELETE /api/waitlist/:id — remove from waitlist
router.delete('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM waitlist WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Waitlist entry not found' });
  db.prepare('DELETE FROM waitlist WHERE id = ?').run(req.params.id);
  res.json({ message: 'Removed from waitlist', id: Number(req.params.id) });
});

// GET /api/waitlist/equipment/:id/position — get position in queue
router.get('/equipment/:id/position', (req, res) => {
  const { user_email } = req.query;
  if (!user_email) return res.status(400).json({ error: 'user_email is required' });
  const entry = db.prepare(`
    SELECT * FROM waitlist WHERE equipment_id = ? AND user_email = ? AND status = 'waiting'
  `).get(req.params.id, user_email);
  if (!entry) return res.status(404).json({ error: 'Not on waitlist for this equipment' });
  const position = db.prepare(`
    SELECT COUNT(*) AS pos FROM waitlist
    WHERE equipment_id = ? AND status = 'waiting' AND created_at <= ?
  `).get(req.params.id, entry.created_at).pos;
  res.json({ position, entry });
});

module.exports = router;
