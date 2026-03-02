'use strict';

const express = require('express');
const router = express.Router();
const db = require('../db/database');

// Helper: check for booking conflicts
function hasConflict(equipment_id, start_time, end_time, exclude_id = null) {
  let sql = `
    SELECT id FROM bookings
    WHERE equipment_id = ?
      AND status = 'confirmed'
      AND start_time < ?
      AND end_time > ?
  `;
  const params = [equipment_id, end_time, start_time];
  if (exclude_id) { sql += ' AND id != ?'; params.push(exclude_id); }
  return db.prepare(sql).get(...params) !== undefined;
}

// GET /api/bookings — list bookings (filter by equipment, lab, user, date range)
router.get('/', (req, res) => {
  const { equipment_id, lab_slug, user_email, from, to, status } = req.query;
  let sql = `
    SELECT b.*, e.name AS equipment_name, e.lab_id
    FROM bookings b
    JOIN equipment e ON b.equipment_id = e.id
    WHERE 1=1
  `;
  const params = [];
  if (equipment_id) { sql += ' AND b.equipment_id = ?'; params.push(equipment_id); }
  if (lab_slug)     { sql += ' AND b.lab_slug = ?'; params.push(lab_slug); }
  if (user_email)   { sql += ' AND b.user_email = ?'; params.push(user_email); }
  if (status)       { sql += ' AND b.status = ?'; params.push(status); }
  if (from)         { sql += ' AND b.end_time >= ?'; params.push(from); }
  if (to)           { sql += ' AND b.start_time <= ?'; params.push(to); }
  sql += ' ORDER BY b.start_time';
  res.json(db.prepare(sql).all(...params));
});

// GET /api/bookings/:id — single booking
router.get('/:id', (req, res) => {
  const row = db.prepare(`
    SELECT b.*, e.name AS equipment_name
    FROM bookings b
    JOIN equipment e ON b.equipment_id = e.id
    WHERE b.id = ?
  `).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Booking not found' });
  res.json(row);
});

// POST /api/bookings — create booking (with conflict detection)
router.post('/', (req, res) => {
  const { equipment_id, user_name, user_email, lab_slug, purpose, start_time, end_time, notes } = req.body;
  if (!equipment_id || !user_name || !user_email || !lab_slug || !start_time || !end_time) {
    return res.status(400).json({ error: 'equipment_id, user_name, user_email, lab_slug, start_time, end_time are required' });
  }
  if (new Date(start_time) >= new Date(end_time)) {
    return res.status(400).json({ error: 'start_time must be before end_time' });
  }
  if (hasConflict(equipment_id, start_time, end_time)) {
    return res.status(409).json({ error: 'Time slot conflicts with an existing booking', conflict: true });
  }
  const result = db.prepare(`
    INSERT INTO bookings (equipment_id, user_name, user_email, lab_slug, purpose, start_time, end_time, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(equipment_id, user_name, user_email, lab_slug, purpose || null, start_time, end_time, notes || null);
  res.status(201).json(db.prepare('SELECT * FROM bookings WHERE id = ?').get(result.lastInsertRowid));
});

// PATCH /api/bookings/:id — update booking
router.patch('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Booking not found' });
  const start_time = req.body.start_time || existing.start_time;
  const end_time   = req.body.end_time   || existing.end_time;
  if (new Date(start_time) >= new Date(end_time)) {
    return res.status(400).json({ error: 'start_time must be before end_time' });
  }
  const equip_id = req.body.equipment_id || existing.equipment_id;
  if (hasConflict(equip_id, start_time, end_time, existing.id)) {
    return res.status(409).json({ error: 'Updated time conflicts with an existing booking', conflict: true });
  }
  const fields = ['user_name', 'user_email', 'lab_slug', 'purpose', 'start_time', 'end_time', 'status', 'notes'];
  const updates = [];
  const params = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) { updates.push(`${f} = ?`); params.push(req.body[f]); }
  }
  updates.push("updated_at = datetime('now')");
  params.push(req.params.id);
  db.prepare(`UPDATE bookings SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  res.json(db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id));
});

// DELETE /api/bookings/:id — cancel booking
router.delete('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Booking not found' });
  db.prepare("UPDATE bookings SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?").run(req.params.id);
  // Notify next person on waitlist
  const next = db.prepare(`
    SELECT * FROM waitlist
    WHERE equipment_id = ? AND status = 'waiting'
    ORDER BY created_at ASC LIMIT 1
  `).get(existing.equipment_id);
  if (next) {
    db.prepare("UPDATE waitlist SET status = 'notified', notified_at = datetime('now') WHERE id = ?").run(next.id);
  }
  res.json({ message: 'Booking cancelled', id: Number(req.params.id), waitlist_notified: !!next });
});

// POST /api/bookings/check-availability — conflict check without creating
router.post('/check-availability', (req, res) => {
  const { equipment_id, start_time, end_time } = req.body;
  if (!equipment_id || !start_time || !end_time) {
    return res.status(400).json({ error: 'equipment_id, start_time, end_time are required' });
  }
  const conflict = hasConflict(equipment_id, start_time, end_time);
  res.json({ available: !conflict, conflict });
});

module.exports = router;
