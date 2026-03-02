'use strict';

const express = require('express');
const router = express.Router();
const db = require('../db/database');

// Helper: compute status from quantity vs min_stock and expiry
function computeStatus(reagent) {
  if (reagent.status === 'disposed') return 'disposed';
  if (reagent.quantity <= 0) return 'depleted';
  if (reagent.quantity <= reagent.min_stock) return 'low-stock';
  return 'in-stock';
}

// GET /api/reagents — list reagents
router.get('/', (req, res) => {
  const { lab_slug, status, expiring_within_days } = req.query;
  let sql = 'SELECT * FROM reagents WHERE 1=1';
  const params = [];
  if (lab_slug) { sql += ' AND lab_slug = ?'; params.push(lab_slug); }
  if (status)   { sql += ' AND status = ?'; params.push(status); }
  if (expiring_within_days) {
    const days = Number(expiring_within_days);
    const cutoff = new Date(Date.now() + days * 86400000).toISOString().split('T')[0];
    sql += ' AND expiry_date IS NOT NULL AND expiry_date <= ? AND status != "disposed"';
    params.push(cutoff);
  }
  sql += ' ORDER BY name';
  const rows = db.prepare(sql).all(...params);
  res.json(rows.map(parseReagent));
});

// GET /api/reagents/:id — single reagent
router.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM reagents WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Reagent not found' });
  res.json(parseReagent(row));
});

// POST /api/reagents — create reagent
router.post('/', (req, res) => {
  const { lab_slug, name, cas_number, catalog_number, manufacturer, lot_number,
          quantity, unit, min_stock, expiry_date, location,
          ghs_hazards, sds_url, unit_cost, notes } = req.body;
  if (!lab_slug || !name) return res.status(400).json({ error: 'lab_slug and name are required' });
  const qty = Number(quantity) || 0;
  const minStock = Number(min_stock) || 0;
  const status = qty <= 0 ? 'depleted' : (qty <= minStock ? 'low-stock' : 'in-stock');
  const result = db.prepare(`
    INSERT INTO reagents
      (lab_slug, name, cas_number, catalog_number, manufacturer, lot_number,
       quantity, unit, min_stock, expiry_date, location, ghs_hazards, sds_url, status, unit_cost, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    lab_slug, name, cas_number || null, catalog_number || null, manufacturer || null,
    lot_number || null, qty, unit || 'g', minStock,
    expiry_date || null, location || null,
    ghs_hazards ? JSON.stringify(ghs_hazards) : null,
    sds_url || null, status, unit_cost ? Number(unit_cost) : null, notes || null
  );
  res.status(201).json(parseReagent(db.prepare('SELECT * FROM reagents WHERE id = ?').get(result.lastInsertRowid)));
});

// PATCH /api/reagents/:id — update reagent
router.patch('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM reagents WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Reagent not found' });
  const textFields = ['lab_slug', 'name', 'cas_number', 'catalog_number', 'manufacturer', 'lot_number',
                      'unit', 'expiry_date', 'location', 'sds_url', 'notes'];
  const numFields = ['quantity', 'min_stock', 'unit_cost'];
  const updates = [];
  const params = [];
  for (const f of textFields) {
    if (req.body[f] !== undefined) { updates.push(`${f} = ?`); params.push(req.body[f]); }
  }
  for (const f of numFields) {
    if (req.body[f] !== undefined) { updates.push(`${f} = ?`); params.push(Number(req.body[f])); }
  }
  if (req.body.ghs_hazards !== undefined) {
    updates.push('ghs_hazards = ?');
    params.push(JSON.stringify(req.body.ghs_hazards));
  }
  if (req.body.status !== undefined) {
    updates.push('status = ?'); params.push(req.body.status);
  }
  if (!updates.length) return res.status(400).json({ error: 'No fields to update' });
  // Auto-compute status if quantity or min_stock changed (and status not explicitly set)
  if (req.body.status === undefined && (req.body.quantity !== undefined || req.body.min_stock !== undefined)) {
    const qty = req.body.quantity !== undefined ? Number(req.body.quantity) : existing.quantity;
    const minS = req.body.min_stock !== undefined ? Number(req.body.min_stock) : existing.min_stock;
    const auto = qty <= 0 ? 'depleted' : (qty <= minS ? 'low-stock' : 'in-stock');
    updates.push('status = ?'); params.push(auto);
  }
  updates.push("updated_at = datetime('now')");
  params.push(req.params.id);
  db.prepare(`UPDATE reagents SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  res.json(parseReagent(db.prepare('SELECT * FROM reagents WHERE id = ?').get(req.params.id)));
});

// DELETE /api/reagents/:id — mark disposed
router.delete('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM reagents WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Reagent not found' });
  db.prepare("UPDATE reagents SET status = 'disposed', updated_at = datetime('now') WHERE id = ?").run(req.params.id);
  res.json({ message: 'Reagent marked as disposed', id: Number(req.params.id) });
});

// GET /api/reagents/:id/usage — usage log for a reagent
router.get('/:id/usage', (req, res) => {
  const rows = db.prepare(`
    SELECT u.*, e.title AS experiment_title
    FROM reagent_usage u
    LEFT JOIN experiments e ON u.experiment_id = e.id
    WHERE u.reagent_id = ?
    ORDER BY u.used_at DESC
  `).all(req.params.id);
  res.json(rows);
});

// POST /api/reagents/:id/usage — log usage
router.post('/:id/usage', (req, res) => {
  const reagent = db.prepare('SELECT * FROM reagents WHERE id = ?').get(req.params.id);
  if (!reagent) return res.status(404).json({ error: 'Reagent not found' });
  const { user_name, quantity_used, unit, purpose, experiment_id, notes } = req.body;
  if (!user_name || !quantity_used || !unit) {
    return res.status(400).json({ error: 'user_name, quantity_used, and unit are required' });
  }
  const used = Number(quantity_used);
  if (used > reagent.quantity) {
    return res.status(409).json({ error: 'Insufficient stock', available: reagent.quantity, unit: reagent.unit });
  }
  const result = db.prepare(`
    INSERT INTO reagent_usage (reagent_id, experiment_id, user_name, quantity_used, unit, purpose, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(req.params.id, experiment_id || null, user_name, used, unit, purpose || null, notes || null);
  // Deduct from inventory
  const newQty = reagent.quantity - used;
  const minS = reagent.min_stock;
  const newStatus = newQty <= 0 ? 'depleted' : (newQty <= minS ? 'low-stock' : 'in-stock');
  db.prepare("UPDATE reagents SET quantity = ?, status = ?, updated_at = datetime('now') WHERE id = ?")
    .run(newQty, newStatus, req.params.id);
  res.status(201).json({
    usage: db.prepare('SELECT * FROM reagent_usage WHERE id = ?').get(result.lastInsertRowid),
    reagent: parseReagent(db.prepare('SELECT * FROM reagents WHERE id = ?').get(req.params.id))
  });
});

// GET /api/reagents/alerts/low-stock — low stock and expiring soon
router.get('/alerts/low-stock', (req, res) => {
  const { lab_slug } = req.query;
  let lowSql = "SELECT * FROM reagents WHERE status IN ('low-stock','depleted')";
  let expSql  = "SELECT * FROM reagents WHERE expiry_date IS NOT NULL AND expiry_date <= date('now', '+60 days') AND status != 'disposed'";
  const params = lab_slug ? [lab_slug] : [];
  if (lab_slug) { lowSql += ' AND lab_slug = ?'; expSql += ' AND lab_slug = ?'; }
  res.json({
    low_stock: db.prepare(lowSql).all(...params).map(parseReagent),
    expiring_soon: db.prepare(expSql).all(...params).map(parseReagent)
  });
});

// GET /api/reagents/inventory/value — total inventory value
router.get('/inventory/value', (req, res) => {
  const { lab_slug } = req.query;
  let sql = "SELECT lab_slug, SUM(quantity * unit_cost) AS total_value, COUNT(*) AS item_count FROM reagents WHERE status != 'disposed'";
  const params = [];
  if (lab_slug) { sql += ' AND lab_slug = ?'; params.push(lab_slug); }
  sql += ' GROUP BY lab_slug';
  res.json(db.prepare(sql).all(...params));
});

function parseReagent(row) {
  return {
    ...row,
    ghs_hazards: row.ghs_hazards ? JSON.parse(row.ghs_hazards) : []
  };
}

module.exports = router;
