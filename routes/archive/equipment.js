'use strict';

const express = require('express');
const router = express.Router();
const db = require('../db/database');

// GET /api/equipment — list all equipment (optionally filter by lab)
router.get('/', (req, res) => {
  const { lab, status, requires_training } = req.query;
  let sql = `
    SELECT e.*, l.name AS lab_name, l.slug AS lab_slug
    FROM equipment e
    JOIN labs l ON e.lab_id = l.id
    WHERE 1=1
  `;
  const params = [];
  if (lab) { sql += ' AND l.slug = ?'; params.push(lab); }
  if (status) { sql += ' AND e.status = ?'; params.push(status); }
  if (requires_training !== undefined) {
    sql += ' AND e.requires_training = ?';
    params.push(requires_training === 'true' ? 1 : 0);
  }
  sql += ' ORDER BY l.name, e.name';
  res.json(db.prepare(sql).all(...params));
});

// GET /api/equipment/:id — single equipment detail
router.get('/:id', (req, res) => {
  const row = db.prepare(`
    SELECT e.*, l.name AS lab_name, l.slug AS lab_slug
    FROM equipment e
    JOIN labs l ON e.lab_id = l.id
    WHERE e.id = ?
  `).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Equipment not found' });
  res.json(row);
});

// POST /api/equipment — create equipment
router.post('/', (req, res) => {
  const { lab_id, name, model, serial_number, description, status, location, requires_training } = req.body;
  if (!lab_id || !name) return res.status(400).json({ error: 'lab_id and name are required' });
  const result = db.prepare(`
    INSERT INTO equipment (lab_id, name, model, serial_number, description, status, location, requires_training)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(lab_id, name, model || null, serial_number || null, description || null,
         status || 'available', location || null, requires_training ? 1 : 0);
  res.status(201).json(db.prepare('SELECT * FROM equipment WHERE id = ?').get(result.lastInsertRowid));
});

// PATCH /api/equipment/:id — update equipment
router.patch('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM equipment WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Equipment not found' });
  const fields = ['name', 'model', 'serial_number', 'description', 'status', 'location', 'requires_training'];
  const updates = [];
  const params = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) {
      updates.push(`${f} = ?`);
      params.push(f === 'requires_training' ? (req.body[f] ? 1 : 0) : req.body[f]);
    }
  }
  if (!updates.length) return res.status(400).json({ error: 'No fields to update' });
  updates.push("updated_at = datetime('now')");
  params.push(req.params.id);
  db.prepare(`UPDATE equipment SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  res.json(db.prepare('SELECT * FROM equipment WHERE id = ?').get(req.params.id));
});

// DELETE /api/equipment/:id — retire (soft delete) equipment
router.delete('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM equipment WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Equipment not found' });
  db.prepare("UPDATE equipment SET status = 'retired', updated_at = datetime('now') WHERE id = ?").run(req.params.id);
  res.json({ message: 'Equipment retired', id: Number(req.params.id) });
});

// GET /api/labs — list all labs
router.get('/labs/all', (req, res) => {
  res.json(db.prepare('SELECT * FROM labs ORDER BY name').all());
});

module.exports = router;
