-- LabLink Initiative — Database Schema
-- SQLite

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ============================================================
-- EQUIPMENT
-- ============================================================

CREATE TABLE IF NOT EXISTS labs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT    NOT NULL UNIQUE,
  name        TEXT    NOT NULL,
  description TEXT,
  location    TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS equipment (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  lab_id         INTEGER NOT NULL REFERENCES labs(id) ON DELETE CASCADE,
  name           TEXT    NOT NULL,
  model          TEXT,
  serial_number  TEXT,
  description    TEXT,
  status         TEXT    NOT NULL DEFAULT 'available' CHECK(status IN ('available','in-use','maintenance','retired')),
  location       TEXT,
  requires_training INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bookings (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  equipment_id INTEGER NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
  user_name    TEXT    NOT NULL,
  user_email   TEXT    NOT NULL,
  lab_slug     TEXT    NOT NULL,
  purpose      TEXT,
  start_time   TEXT    NOT NULL,
  end_time     TEXT    NOT NULL,
  status       TEXT    NOT NULL DEFAULT 'confirmed' CHECK(status IN ('confirmed','cancelled','completed')),
  notes        TEXT,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS waitlist (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  equipment_id INTEGER NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
  user_name    TEXT    NOT NULL,
  user_email   TEXT    NOT NULL,
  lab_slug     TEXT    NOT NULL,
  requested_start TEXT NOT NULL,
  requested_end   TEXT NOT NULL,
  purpose      TEXT,
  status       TEXT    NOT NULL DEFAULT 'waiting' CHECK(status IN ('waiting','notified','booked','cancelled')),
  notified_at  TEXT,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- LAB NOTEBOOK
-- ============================================================

CREATE TABLE IF NOT EXISTS experiments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  lab_slug      TEXT    NOT NULL,
  title         TEXT    NOT NULL,
  hypothesis    TEXT,
  materials     TEXT,
  procedure     TEXT,
  observations  TEXT,
  results       TEXT,
  conclusions   TEXT,
  tags          TEXT,   -- JSON array stored as text
  equipment_ids TEXT,   -- JSON array of equipment IDs
  status        TEXT    NOT NULL DEFAULT 'in-progress' CHECK(status IN ('in-progress','completed','archived')),
  created_by    TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- REAGENT INVENTORY
-- ============================================================

CREATE TABLE IF NOT EXISTS reagents (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  lab_slug        TEXT    NOT NULL,
  name            TEXT    NOT NULL,
  cas_number      TEXT,
  catalog_number  TEXT,
  manufacturer    TEXT,
  lot_number      TEXT,
  quantity        REAL    NOT NULL DEFAULT 0,
  unit            TEXT    NOT NULL DEFAULT 'g',
  min_stock       REAL    NOT NULL DEFAULT 0,
  expiry_date     TEXT,
  location        TEXT,
  ghs_hazards     TEXT,   -- JSON array: ['flammable','toxic', ...]
  sds_url         TEXT,
  status          TEXT    NOT NULL DEFAULT 'in-stock' CHECK(status IN ('in-stock','low-stock','depleted','disposed')),
  unit_cost       REAL,
  notes           TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reagent_usage (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  reagent_id    INTEGER NOT NULL REFERENCES reagents(id) ON DELETE CASCADE,
  experiment_id INTEGER REFERENCES experiments(id) ON DELETE SET NULL,
  user_name     TEXT    NOT NULL,
  quantity_used REAL    NOT NULL,
  unit          TEXT    NOT NULL,
  purpose       TEXT,
  used_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  notes         TEXT
);

-- ============================================================
-- EQUIPMENT CALIBRATION
-- ============================================================

CREATE TABLE IF NOT EXISTS calibrations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  equipment_id    INTEGER NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
  calibration_date TEXT   NOT NULL,
  next_due_date   TEXT,
  performed_by    TEXT    NOT NULL,
  calibration_type TEXT   NOT NULL DEFAULT 'internal' CHECK(calibration_type IN ('internal','external','accredited')),
  cert_number     TEXT,
  cert_pdf_url    TEXT,
  result          TEXT    NOT NULL DEFAULT 'pass' CHECK(result IN ('pass','fail','conditional')),
  notes           TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- SEED DATA
-- ============================================================

INSERT OR IGNORE INTO labs (slug, name, description, location)
VALUES
  ('bio-lab',   'Biology Lab',         'General molecular biology and genetics lab',    'Building A, Room 101'),
  ('chem-lab',  'Chemistry Lab',       'Organic and inorganic chemistry research',      'Building B, Room 204'),
  ('phys-lab',  'Physics Lab',         'Electronics, optics, and mechanics',            'Building C, Room 305'),
  ('comp-lab',  'Computing Lab',       'High-performance computing and data science',   'Building D, Room 102');

INSERT OR IGNORE INTO equipment (lab_id, name, model, description, status, location) SELECT id, 'PCR Thermocycler', 'Bio-Rad T100', 'Polymerase chain reaction thermocycler', 'available', 'Bench 1' FROM labs WHERE slug = 'bio-lab';
INSERT OR IGNORE INTO equipment (lab_id, name, model, description, status, location) SELECT id, 'Gel Electrophoresis', 'Bio-Rad Mini-Sub', 'Agarose gel electrophoresis system', 'available', 'Bench 2' FROM labs WHERE slug = 'bio-lab';
INSERT OR IGNORE INTO equipment (lab_id, name, model, description, status, location) SELECT id, 'Centrifuge', 'Eppendorf 5424', 'Benchtop microcentrifuge 24-place', 'available', 'Bench 3' FROM labs WHERE slug = 'bio-lab';
INSERT OR IGNORE INTO equipment (lab_id, name, model, description, status, location) SELECT id, 'Fume Hood', 'AirClean AC632', 'Chemical fume hood with UV sterilizer', 'available', 'Station 1' FROM labs WHERE slug = 'chem-lab';
INSERT OR IGNORE INTO equipment (lab_id, name, model, description, status, location) SELECT id, 'Rotary Evaporator', 'Buchi R-300', 'Solvent evaporation and concentration', 'available', 'Station 2' FROM labs WHERE slug = 'chem-lab';
INSERT OR IGNORE INTO equipment (lab_id, name, model, description, status, location) SELECT id, 'Oscilloscope', 'Rigol DS1054Z', '4-channel 50MHz digital oscilloscope', 'available', 'Bench A' FROM labs WHERE slug = 'phys-lab';
INSERT OR IGNORE INTO equipment (lab_id, name, model, description, status, location) SELECT id, 'Function Generator', 'Rigol DG1022Z', '25MHz arbitrary waveform generator', 'available', 'Bench B' FROM labs WHERE slug = 'phys-lab';
INSERT OR IGNORE INTO equipment (lab_id, name, model, description, status, location) SELECT id, 'GPU Workstation', 'Custom RTX 4090', '64GB RAM, 4TB NVMe, ML workstation', 'available', 'Station 1' FROM labs WHERE slug = 'comp-lab';
