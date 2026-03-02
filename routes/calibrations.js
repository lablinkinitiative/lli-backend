'use strict';

const express = require('express');
const router = express.Router();
const db = require('../db/database');

// Helper: compute compliance status
function complianceStatus(nextDueDate) {
  if (!nextDueDate) return 'no-schedule';
  const now = new Date();
  const due = new Date(nextDueDate);
  const daysLeft = (due - now) / 86400000;
  if (daysLeft < 0)  return 'overdue';
  if (daysLeft <= 30) return 'due-soon';
  return 'compliant';
}

// GET /api/calibrations — list all calibrations
router.get('/', (req, res) => {
  const { equipment_id, lab_slug, compliance } = req.query;
  let sql = `
    SELECT c.*, e.name AS equipment_name, e.lab_id, l.slug AS lab_slug_eq, l.name AS lab_name
    FROM calibrations c
    JOIN equipment e ON c.equipment_id = e.id
    JOIN labs l ON e.lab_id = l.id
    WHERE 1=1
  `;
  const params = [];
  if (equipment_id) { sql += ' AND c.equipment_id = ?'; params.push(equipment_id); }
  if (lab_slug)     { sql += ' AND l.slug = ?'; params.push(lab_slug); }
  sql += ' ORDER BY c.calibration_date DESC';
  let rows = db.prepare(sql).all(...params).map(r => ({ ...r, compliance: complianceStatus(r.next_due_date) }));
  if (compliance) rows = rows.filter(r => r.compliance === compliance);
  res.json(rows);
});

// GET /api/calibrations/:id — single calibration record
router.get('/:id', (req, res) => {
  const row = db.prepare(`
    SELECT c.*, e.name AS equipment_name
    FROM calibrations c
    JOIN equipment e ON c.equipment_id = e.id
    WHERE c.id = ?
  `).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Calibration record not found' });
  res.json({ ...row, compliance: complianceStatus(row.next_due_date) });
});

// GET /api/calibrations/equipment/:id — calibration history for an equipment item
router.get('/equipment/:id', (req, res) => {
  const rows = db.prepare(`
    SELECT c.*, e.name AS equipment_name
    FROM calibrations c
    JOIN equipment e ON c.equipment_id = e.id
    WHERE c.equipment_id = ?
    ORDER BY c.calibration_date DESC
  `).all(req.params.id);
  res.json(rows.map(r => ({ ...r, compliance: complianceStatus(r.next_due_date) })));
});

// POST /api/calibrations — record calibration
router.post('/', (req, res) => {
  const { equipment_id, calibration_date, next_due_date, performed_by,
          calibration_type, cert_number, cert_pdf_url, result, notes } = req.body;
  if (!equipment_id || !calibration_date || !performed_by) {
    return res.status(400).json({ error: 'equipment_id, calibration_date, performed_by are required' });
  }
  const equipment = db.prepare('SELECT * FROM equipment WHERE id = ?').get(equipment_id);
  if (!equipment) return res.status(404).json({ error: 'Equipment not found' });
  const insertResult = db.prepare(`
    INSERT INTO calibrations
      (equipment_id, calibration_date, next_due_date, performed_by, calibration_type, cert_number, cert_pdf_url, result, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    equipment_id, calibration_date, next_due_date || null, performed_by,
    calibration_type || 'internal', cert_number || null, cert_pdf_url || null,
    result || 'pass', notes || null
  );
  const record = db.prepare('SELECT * FROM calibrations WHERE id = ?').get(insertResult.lastInsertRowid);
  res.status(201).json({ ...record, compliance: complianceStatus(record.next_due_date) });
});

// PATCH /api/calibrations/:id — update calibration record
router.patch('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM calibrations WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Calibration record not found' });
  const fields = ['calibration_date', 'next_due_date', 'performed_by', 'calibration_type',
                  'cert_number', 'cert_pdf_url', 'result', 'notes'];
  const updates = [];
  const params = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) { updates.push(`${f} = ?`); params.push(req.body[f]); }
  }
  if (!updates.length) return res.status(400).json({ error: 'No fields to update' });
  params.push(req.params.id);
  db.prepare(`UPDATE calibrations SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  const record = db.prepare('SELECT * FROM calibrations WHERE id = ?').get(req.params.id);
  res.json({ ...record, compliance: complianceStatus(record.next_due_date) });
});

// DELETE /api/calibrations/:id — delete a calibration record
router.delete('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM calibrations WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Calibration record not found' });
  db.prepare('DELETE FROM calibrations WHERE id = ?').run(req.params.id);
  res.json({ message: 'Calibration record deleted', id: Number(req.params.id) });
});

// GET /api/calibrations/compliance/summary — compliance overview
router.get('/compliance/summary', (req, res) => {
  const { lab_slug } = req.query;
  let sql = `
    SELECT c.equipment_id, e.name AS equipment_name, l.slug AS lab_slug, l.name AS lab_name,
           c.next_due_date, c.calibration_date, c.cert_number
    FROM calibrations c
    JOIN equipment e ON c.equipment_id = e.id
    JOIN labs l ON e.lab_id = l.id
    WHERE c.id = (
      SELECT id FROM calibrations WHERE equipment_id = c.equipment_id ORDER BY calibration_date DESC LIMIT 1
    )
  `;
  const params = [];
  if (lab_slug) { sql += ' AND l.slug = ?'; params.push(lab_slug); }
  const rows = db.prepare(sql).all(...params)
    .map(r => ({ ...r, compliance: complianceStatus(r.next_due_date) }));
  const summary = {
    compliant: rows.filter(r => r.compliance === 'compliant').length,
    due_soon: rows.filter(r => r.compliance === 'due-soon').length,
    overdue: rows.filter(r => r.compliance === 'overdue').length,
    no_schedule: rows.filter(r => r.compliance === 'no-schedule').length,
    items: rows
  };
  res.json(summary);
});

module.exports = router;
