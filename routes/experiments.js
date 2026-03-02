'use strict';

const express = require('express');
const router = express.Router();
const db = require('../db/database');

// GET /api/labs/:slug/experiments — list experiments for a lab
router.get('/:slug/experiments', (req, res) => {
  const { status, tag, created_by } = req.query;
  let sql = 'SELECT * FROM experiments WHERE lab_slug = ?';
  const params = [req.params.slug];
  if (status)     { sql += ' AND status = ?'; params.push(status); }
  if (created_by) { sql += ' AND created_by = ?'; params.push(created_by); }
  if (tag) {
    sql += " AND tags LIKE ?";
    params.push(`%"${tag}"%`);
  }
  sql += ' ORDER BY created_at DESC';
  const rows = db.prepare(sql).all(...params);
  res.json(rows.map(parseExperiment));
});

// GET /api/labs/:slug/experiments/:id — single experiment
router.get('/:slug/experiments/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM experiments WHERE id = ? AND lab_slug = ?')
    .get(req.params.id, req.params.slug);
  if (!row) return res.status(404).json({ error: 'Experiment not found' });
  res.json(parseExperiment(row));
});

// POST /api/labs/:slug/experiments — create experiment
router.post('/:slug/experiments', (req, res) => {
  const { title, hypothesis, materials, procedure, observations, results, conclusions, tags, equipment_ids, status, created_by } = req.body;
  if (!title) return res.status(400).json({ error: 'title is required' });
  const result = db.prepare(`
    INSERT INTO experiments
      (lab_slug, title, hypothesis, materials, procedure, observations, results, conclusions, tags, equipment_ids, status, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    req.params.slug, title,
    hypothesis || null, materials || null, procedure || null,
    observations || null, results || null, conclusions || null,
    tags ? JSON.stringify(tags) : null,
    equipment_ids ? JSON.stringify(equipment_ids) : null,
    status || 'in-progress', created_by || null
  );
  res.status(201).json(parseExperiment(db.prepare('SELECT * FROM experiments WHERE id = ?').get(result.lastInsertRowid)));
});

// PATCH /api/labs/:slug/experiments/:id — update experiment
router.patch('/:slug/experiments/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM experiments WHERE id = ? AND lab_slug = ?')
    .get(req.params.id, req.params.slug);
  if (!existing) return res.status(404).json({ error: 'Experiment not found' });

  const textFields = ['title', 'hypothesis', 'materials', 'procedure', 'observations', 'results', 'conclusions', 'status', 'created_by'];
  const jsonFields = ['tags', 'equipment_ids'];
  const updates = [];
  const params = [];

  for (const f of textFields) {
    if (req.body[f] !== undefined) { updates.push(`${f} = ?`); params.push(req.body[f]); }
  }
  for (const f of jsonFields) {
    if (req.body[f] !== undefined) {
      updates.push(`${f} = ?`);
      params.push(JSON.stringify(req.body[f]));
    }
  }
  if (!updates.length) return res.status(400).json({ error: 'No fields to update' });
  updates.push("updated_at = datetime('now')");
  params.push(req.params.id);
  db.prepare(`UPDATE experiments SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  res.json(parseExperiment(db.prepare('SELECT * FROM experiments WHERE id = ?').get(req.params.id)));
});

// DELETE /api/labs/:slug/experiments/:id — archive experiment
router.delete('/:slug/experiments/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM experiments WHERE id = ? AND lab_slug = ?')
    .get(req.params.id, req.params.slug);
  if (!existing) return res.status(404).json({ error: 'Experiment not found' });
  db.prepare("UPDATE experiments SET status = 'archived', updated_at = datetime('now') WHERE id = ?").run(req.params.id);
  res.json({ message: 'Experiment archived', id: Number(req.params.id) });
});

function parseExperiment(row) {
  return {
    ...row,
    tags: row.tags ? JSON.parse(row.tags) : [],
    equipment_ids: row.equipment_ids ? JSON.parse(row.equipment_ids) : []
  };
}

module.exports = router;
