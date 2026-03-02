'use strict';

const express = require('express');
const router = express.Router();
const db = require('../db/database');

// GET /api/labs — list all labs
router.get('/', (req, res) => {
  res.json(db.prepare('SELECT * FROM labs ORDER BY name').all());
});

// GET /api/labs/:slug — single lab with equipment summary
router.get('/:slug', (req, res) => {
  const lab = db.prepare('SELECT * FROM labs WHERE slug = ?').get(req.params.slug);
  if (!lab) return res.status(404).json({ error: 'Lab not found' });
  const equipment = db.prepare('SELECT * FROM equipment WHERE lab_id = ? ORDER BY name').all(lab.id);
  res.json({ ...lab, equipment });
});

// POST /api/labs — create lab
router.post('/', (req, res) => {
  const { slug, name, description, location } = req.body;
  if (!slug || !name) return res.status(400).json({ error: 'slug and name are required' });
  const existing = db.prepare('SELECT id FROM labs WHERE slug = ?').get(slug);
  if (existing) return res.status(409).json({ error: 'Lab with this slug already exists' });
  const result = db.prepare('INSERT INTO labs (slug, name, description, location) VALUES (?, ?, ?, ?)')
    .run(slug, name, description || null, location || null);
  res.status(201).json(db.prepare('SELECT * FROM labs WHERE id = ?').get(result.lastInsertRowid));
});

// PATCH /api/labs/:slug — update lab
router.patch('/:slug', (req, res) => {
  const existing = db.prepare('SELECT * FROM labs WHERE slug = ?').get(req.params.slug);
  if (!existing) return res.status(404).json({ error: 'Lab not found' });
  const fields = ['name', 'description', 'location'];
  const updates = [];
  const params = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) { updates.push(`${f} = ?`); params.push(req.body[f]); }
  }
  if (!updates.length) return res.status(400).json({ error: 'No fields to update' });
  params.push(req.params.slug);
  db.prepare(`UPDATE labs SET ${updates.join(', ')} WHERE slug = ?`).run(...params);
  res.json(db.prepare('SELECT * FROM labs WHERE slug = ?').get(req.params.slug));
});

module.exports = router;
