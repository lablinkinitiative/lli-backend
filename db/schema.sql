-- LabLink Initiative — CDP Database Schema
-- SQLite

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ============================================================
-- CDP STUDENTS
-- ============================================================

CREATE TABLE IF NOT EXISTS cdp_students (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  uid             TEXT    NOT NULL UNIQUE,          -- UUID
  email           TEXT    NOT NULL UNIQUE,
  password_hash   TEXT    NOT NULL,
  first_name      TEXT    NOT NULL,
  last_name       TEXT    NOT NULL,
  school          TEXT,
  graduation_year INTEGER,
  major           TEXT,
  bio             TEXT,
  linkedin_url    TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- CDP PROGRAMS (catalog of STEM programs/internships)
-- ============================================================

CREATE TABLE IF NOT EXISTS cdp_programs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  slug            TEXT    NOT NULL UNIQUE,
  title           TEXT    NOT NULL,
  organization    TEXT    NOT NULL,
  description     TEXT,
  program_type    TEXT    NOT NULL DEFAULT 'internship'
                    CHECK(program_type IN ('internship','fellowship','scholarship','workshop','research','other')),
  stem_fields     TEXT,   -- JSON array: ["biology","chemistry","physics","cs","engineering"]
  eligibility     TEXT,   -- JSON: {"gpa": 3.0, "year": ["sophomore","junior"]}
  deadline        TEXT,
  start_date      TEXT,
  end_date        TEXT,
  stipend         TEXT,
  location        TEXT,
  remote          INTEGER NOT NULL DEFAULT 0,
  url             TEXT,
  is_active       INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- CDP SAVED PROGRAMS (student bookmarks)
-- ============================================================

CREATE TABLE IF NOT EXISTS cdp_saved_programs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id  INTEGER NOT NULL REFERENCES cdp_students(id) ON DELETE CASCADE,
  program_id  INTEGER NOT NULL REFERENCES cdp_programs(id) ON DELETE CASCADE,
  notes       TEXT,
  saved_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(student_id, program_id)
);

-- ============================================================
-- CDP GAP ANALYSES (AI-generated readiness assessments)
-- ============================================================

CREATE TABLE IF NOT EXISTS cdp_gap_analyses (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id      INTEGER NOT NULL REFERENCES cdp_students(id) ON DELETE CASCADE,
  program_id      INTEGER REFERENCES cdp_programs(id) ON DELETE SET NULL,
  readiness_score INTEGER,   -- 0-100
  strengths       TEXT,      -- JSON array of strings
  gaps            TEXT,      -- JSON array of strings
  recommendations TEXT,      -- JSON array of action items
  generated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- SEED DATA — Programs
-- ============================================================

INSERT OR IGNORE INTO cdp_programs (slug, title, organization, description, program_type, stem_fields, deadline, stipend, location, url)
VALUES
  ('nsf-reu-biology', 'NSF REU — Biological Sciences', 'National Science Foundation',
   'Research Experience for Undergraduates in biological sciences at universities nationwide.',
   'research', '["biology","biochemistry"]', NULL, '$600/week + housing', 'Various US universities',
   'https://www.nsf.gov/crssprgm/reu/'),

  ('doe-scurf', 'Science Undergraduate Laboratory Internship', 'U.S. Department of Energy',
   'Paid internships at DOE national laboratories — STEM research across all disciplines.',
   'internship', '["biology","chemistry","physics","cs","engineering"]', NULL, '$600-800/week', 'National Laboratories',
   'https://science.osti.gov/wdts/suli'),

  ('nih-sip', 'NIH Summer Internship Program', 'National Institutes of Health',
   'Biomedical research internships at NIH campuses in Bethesda and across the country.',
   'internship', '["biology","biochemistry","public-health"]', '2026-03-01', '$20/hour', 'Bethesda, MD + remote options',
   'https://www.training.nih.gov/programs/sip');
