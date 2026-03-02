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

// ── GET /export/cdp-format ────────────────────────────────
// Returns programs converted to CDP app Program format for programs.json sync

// Use SECTOR_LABELS (defined below with inferSector) for the export endpoint
const SECTOR_TO_CATEGORY = {
  doe_labs:         'DOE National Labs',
  federal_science:  'Federal Science Agencies',
  space_defense:    'Space & Defense',
  biomedical:       'Biomedical & Health',
  high_school:      'High School Programs',
  diversity_bridge: 'Equity & Access',
  industry_tech:    'Industry: Tech & Computing',
  industry_biotech: 'Industry: Life Sciences',
  industry_energy:  'Industry: Energy & Climate',
  environmental:    'Environmental Science',
  community_college:'Community College',
  fellowships:      'Competitive Fellowships',
  academic:         'University Research',
  other:            'Academic Research',
};

const FIELD_TO_AREA = {
  biology: 'Biology', chemistry: 'Chemistry', physics: 'Physics',
  cs: 'Computer Science', engineering: 'Engineering', math: 'Mathematics',
  'environmental-science': 'Environmental Science', 'public-health': 'Public Health',
  neuroscience: 'Neuroscience', 'materials-science': 'Materials Science',
  astronomy: 'Astronomy', geology: 'Geology', 'data-science': 'Data Science',
  biomedical: 'Biomedical', 'mechanical-engineering': 'Mechanical Engineering',
  'electrical-engineering': 'Electrical Engineering', 'chemical-engineering': 'Chemical Engineering',
  aerospace: 'Aerospace', nuclear: 'Nuclear', other: 'STEM',
};

const EDLEVEL_MAP = {
  'high-school': 'High School', 'community-college': 'Community College',
  undergraduate: 'Undergraduate', graduate: 'Graduate', 'post-baccalaureate': 'Post-Baccalaureate',
  phd: 'PhD', postdoc: 'Postdoc',
};

router.get('/export/cdp-format', (req, res) => {
  if (!_slugSectorMap) _slugSectorMap = buildSlugSectorMap();
  const programs = db.prepare('SELECT * FROM cdp_programs WHERE is_active = 1 ORDER BY created_at DESC').all();

  const cdpPrograms = programs.map(p => {
    const sector = p.sector || _slugSectorMap[p.slug] || inferSector(p.slug, p.program_type, p.organization);
    const category = SECTOR_TO_CATEGORY[sector] || 'Academic Research';

    // Parse JSON fields safely
    let eligObj = {};
    try { eligObj = p.eligibility ? JSON.parse(p.eligibility) : {}; } catch (_) {}
    let fieldsArr = [];
    try { fieldsArr = p.stem_fields ? JSON.parse(p.stem_fields) : []; } catch (_) {}
    if (!Array.isArray(fieldsArr)) fieldsArr = [fieldsArr];

    const edLevels = (eligObj.education_level || []).map(l => EDLEVEL_MAP[l] || l);
    const citizenship = eligObj.citizenship ? [eligObj.citizenship] : ['Open'];
    const researchAreas = fieldsArr.map(f => FIELD_TO_AREA[f] || f).filter(Boolean).slice(0, 5);

    const stipend = p.stipend || '';
    const isPaid = !!(stipend && !/unpaid|volunteer|no stipend/i.test(stipend));

    let deadlines = {};
    if (p.deadline) deadlines['Application'] = p.deadline;

    const locations = p.location ? p.location.split('; ').map(l => l.trim()).slice(0, 5) : [];

    // Short name: first ~30 chars of title or common abbreviation
    const shortName = p.title.length > 30
      ? (p.title.match(/\(([^)]+)\)$/) || ['', p.title.slice(0, 25)])[1] || p.title.slice(0, 25) + '…'
      : p.title;

    return {
      id: p.slug,
      name: p.title,
      shortName,
      category,
      type: p.program_type || 'internship',
      eligibility: {
        level: edLevels.length ? edLevels : ['Undergraduate'],
        citizenship,
        gpa: eligObj.gpa_min || null,
        notes: eligObj.notes || '',
      },
      duration: { weeks: null, terms: [] },
      compensation: {
        paid: isPaid,
        stipend: stipend || 'See program details',
        housing: stipend && /housing/i.test(stipend) ? 'Housing may be provided' : undefined,
      },
      locations,
      researchAreas,
      deadlines,
      applicationUrl: p.url || `https://lablinkinitiative.org/internships.html`,
      applicationPlatform: 'Direct',
      keyFacts: p.description ? [p.description.slice(0, 200) + (p.description.length > 200 ? '…' : '')] : [],
      lliBridgeNote: '',
    };
  });

  res.json({ programs: cdpPrograms, total: cdpPrograms.length, generatedAt: new Date().toISOString() });
});

// ── GET /intern/opportunities ────────────────────────────────
// Returns programs in intern site format with multi-category support

const fs = require('fs');
const path = require('path');

// ── Sector display labels ─────────────────────────────────────
const SECTOR_LABELS = {
  doe_labs:         'DOE National Labs',
  federal_science:  'Federal Science Agencies',
  space_defense:    'Space & Defense',
  biomedical:       'Biomedical & Health',
  industry_tech:    'Industry: Tech & Computing',
  industry_biotech: 'Industry: Life Sciences',
  industry_energy:  'Industry: Energy & Climate',
  environmental:    'Environmental Science',
  diversity_bridge: 'Equity & Access',
  high_school:      'High School Programs',
  community_college:'Community College',
  fellowships:      'Competitive Fellowships',
  academic:         'University Research',
  other:            'Other',
};

// ── Improved sector inference (slug-prefix + org fallback) ────
function inferSector(slug, programType, organization) {
  const s = slug.toLowerCase();
  const org = (organization || '').toLowerCase();

  // DOE National Labs — specific lab abbreviations first
  if (s.startsWith('doe-') || s.startsWith('suli-') || s.startsWith('scgsr-') || s.startsWith('nnsa-') ||
      s.startsWith('inl-') || s.startsWith('ornl-') || s.startsWith('llnl-') || s.startsWith('sandia-') ||
      s.startsWith('pnnl-') || s.startsWith('nrel-') || s.startsWith('anl-') || s.startsWith('lbnl-') ||
      s.startsWith('bnl-') || s.startsWith('fermilab-') || s.startsWith('slac-') || s.startsWith('lanl-') ||
      s.startsWith('orau-') || s.startsWith('orise-') || s.startsWith('ames-lab-') || s.startsWith('snl-') ||
      s.startsWith('tjnaf-') || s.startsWith('srnl-')) return 'doe_labs';

  // Federal Science
  if (s.startsWith('nsf-') || s.startsWith('nih-') || s.startsWith('noaa-') || s.startsWith('epa-') ||
      s.startsWith('usda-') || s.startsWith('usgs-') || s.startsWith('nist-') || s.startsWith('smithsonian-') ||
      s.startsWith('usaid-') || s.startsWith('census-') || s.startsWith('nps-') || s.startsWith('fws-')) return 'federal_science';

  // Space & Defense
  if (s.startsWith('nasa-') || s.startsWith('afrl-') || s.startsWith('nreip-') || s.startsWith('smart-') ||
      s.startsWith('dod-') || s.startsWith('darpa-') || s.startsWith('afosr-') || s.startsWith('space-') ||
      s.startsWith('seds-') || s.startsWith('arpa-')) return 'space_defense';

  // Biomedical
  if (s.startsWith('hhmi-') || s.startsWith('jackson-') || s.startsWith('mayo-') || s.startsWith('amgen-scholars') ||
      s.startsWith('surf-caltech') || s.startsWith('mskcc-') || s.startsWith('dana-farber-') ||
      s.startsWith('cold-spring-') || s.startsWith('salk-')) return 'biomedical';

  // Diversity & Equity
  if (s.startsWith('marc-') || s.startsWith('lsamp-') || s.startsWith('mcnair-') || s.startsWith('aises-') ||
      s.startsWith('sacnas-') || s.startsWith('nnbms-') || s.startsWith('abrcms-') || s.startsWith('hacu-') ||
      s.startsWith('hbcu-') || s.startsWith('trio-') || s.startsWith('nsbe-') || s.startsWith('swe-') ||
      s.startsWith('shpe-') || s.startsWith('bridges-') || s.startsWith('the-alliance-') ||
      s.startsWith('nnbms-') || s.startsWith('gen-10-')) return 'diversity_bridge';

  // High School
  if (s.startsWith('rsi-') || s.startsWith('smash-') || s.startsWith('primes-') || s.startsWith('histep-') ||
      s.startsWith('high-school-') || s.startsWith('ssp-') || s.startsWith('hs-') ||
      s.includes('-high-school') || s.startsWith('tasp-') || s.startsWith('research-science-initiative')) return 'high_school';

  // Industry: Energy & Climate
  if (s.startsWith('tesla-') || s.startsWith('nextera-') || s.startsWith('next-era-') || s.startsWith('sunrun-') ||
      s.startsWith('vestas-') || s.startsWith('first-solar-') || s.startsWith('chevron-') || s.startsWith('exxon-') ||
      s.startsWith('bp-') || s.startsWith('shell-') || s.startsWith('halliburton-') || s.startsWith('nrg-')) return 'industry_energy';

  // Industry: Life Sciences / Biotech
  if (s.startsWith('genentech-') || s.startsWith('amgen-') || s.startsWith('illumina-') || s.startsWith('regeneron-') ||
      s.startsWith('biogen-') || s.startsWith('vertex-') || s.startsWith('crispr-') || s.startsWith('10x-genomics-') ||
      s.startsWith('abbvie-') || s.startsWith('merck-') || s.startsWith('pfizer-') || s.startsWith('bristol-myers-')) return 'industry_biotech';

  // Industry: Tech & Computing
  if (s.startsWith('google-') || s.startsWith('nvidia-') || s.startsWith('microsoft-') || s.startsWith('intel-') ||
      s.startsWith('boeing-') || s.startsWith('lockheed-') || s.startsWith('apple-') || s.startsWith('meta-') ||
      s.startsWith('amazon-') || s.startsWith('ibm-') || s.startsWith('qualcomm-') || s.startsWith('amd-') ||
      s.startsWith('salesforce-') || s.startsWith('linkedin-') || s.startsWith('uber-') || s.startsWith('adobe-') ||
      s.startsWith('intuit-') || s.startsWith('tsmc-') || s.startsWith('broadcom-') || s.startsWith('twitter-') ||
      s.startsWith('tiktok-') || s.startsWith('snap-') || s.startsWith('roblox-') || s.startsWith('palantir-')) return 'industry_tech';

  // Environmental Science
  if (s.startsWith('edf-') || s.startsWith('nrdc-') || s.startsWith('sierra-club-') || s.startsWith('wri-') ||
      s.startsWith('rmi-') || s.startsWith('rocky-mountain-') || s.startsWith('conservation-') ||
      s.startsWith('wwf-') || s.startsWith('nature-conservancy-')) return 'environmental';

  // Community College
  if (s.startsWith('ccsep-') || s.startsWith('year-up-') || s.startsWith('ncas-') || s.startsWith('cc-') ||
      s.includes('community-college') || s.startsWith('ptk-')) return 'community_college';

  // Competitive Fellowships — check programType first, then slug
  if (programType === 'fellowship' || programType === 'scholarship') return 'fellowships';
  if (s.startsWith('goldwater-') || s.startsWith('grfp-') || s.startsWith('hertz-') || s.startsWith('nsf-graduate-') ||
      s.startsWith('soros-') || s.startsWith('churchill-') || s.startsWith('knight-') || s.startsWith('fulbright-') ||
      s.startsWith('barry-') || s.startsWith('nsf-grfp') || s.startsWith('doe-csgf')) return 'fellowships';

  // Organization-based fallback
  if (org.includes('national lab') || org.includes('department of energy') || org === 'doe national labs') return 'doe_labs';
  if (org.includes('smithsonian') || org.includes('nsf') || org.includes('noaa') || org.includes('usda') ||
      org.includes('federal') && !org.includes('platform')) return 'federal_science';
  if (org.includes('nasa') || org.includes('space') || org.includes('defense') || org.includes('air force')) return 'space_defense';
  if (org.includes('industry') && org.includes('energy') || org.includes('clean energy') || org.includes('solar') ||
      org.includes('wind energy')) return 'industry_energy';
  if (org.includes('industry') && org.includes('tech') || org.includes('computing') || org.includes('software')) return 'industry_tech';
  if (org.includes('equity') || org.includes('diversity') || org.includes('bridge') || org.includes('professional org')) return 'diversity_bridge';
  if (org.includes('community college')) return 'community_college';
  if (org.includes('platform') || org.includes('aggregator')) return 'other';

  return 'other';
}

// ── Derive all applicable categories for a program ───────────
function deriveCategories(primarySector, slug, eligibility, programType, stemFields, organization) {
  const cats = new Set([primarySector]);
  const s = slug.toLowerCase();
  const org = (organization || '').toLowerCase();

  // Cross-list HS programs
  if (primarySector !== 'high_school' && (s.includes('high-school') || s.includes('hs-'))) cats.add('high_school');

  // Cross-list CC programs
  if (primarySector !== 'community_college') {
    try {
      const elig = typeof eligibility === 'string' ? JSON.parse(eligibility || '{}') : (eligibility || {});
      if (elig.education_level && elig.education_level.includes('community-college')) cats.add('community_college');
    } catch (_) {}
    if (s.includes('community-college') || s.startsWith('cc-') || org.includes('community college')) cats.add('community_college');
  }

  // Cross-list diversity programs
  if (primarySector !== 'diversity_bridge') {
    const diversityKeywords = ['diversity', 'underrepresented', 'minority', 'hbcu', 'hacu', 'tribal', 'first-gen',
                               'women', 'lsamp', 'mcnair', 'marc', 'aises', 'sacnas', 'nsbe', 'shpe', 'swe', 'hacu'];
    if (diversityKeywords.some(k => s.includes(k) || org.includes(k))) cats.add('diversity_bridge');
  }

  // Cross-list fellowships
  if (primarySector !== 'fellowships' && (programType === 'fellowship' || programType === 'scholarship')) {
    cats.add('fellowships');
  }

  // Cross-list biomedical sector programs that have biomedical STEM fields
  if (primarySector !== 'biomedical') {
    try {
      const fields = typeof stemFields === 'string' ? JSON.parse(stemFields || '[]') : (stemFields || []);
      if (fields.some(f => ['biomedical', 'public-health', 'neuroscience'].includes(f))) cats.add('biomedical');
    } catch (_) {}
  }

  // Cross-list environmental
  if (primarySector !== 'environmental') {
    try {
      const fields = typeof stemFields === 'string' ? JSON.parse(stemFields || '[]') : (stemFields || []);
      if (fields.some(f => ['environmental-science', 'geology'].includes(f))) cats.add('environmental');
    } catch (_) {}
  }

  return Array.from(cats);
}

function buildSlugSectorMap() {
  const map = {};
  const sectorNames = {
    '01-doe-national-labs': 'doe_labs',
    '02-federal-science': 'federal_science',
    '03-space-defense': 'space_defense',
    '04-biomedical-health': 'biomedical',
    '05-high-school': 'high_school',
    '06-diversity-bridge': 'diversity_bridge',
    '07-industry-tech': 'industry_tech',
    '08-community-college': 'community_college',
    '09-competitive-fellowships': 'fellowships',
  };
  const outputDir = path.join(__dirname, '..', 'pipeline', 'output');
  for (const [fname, sector] of Object.entries(sectorNames)) {
    const fpath = path.join(outputDir, `${fname}.json`);
    try {
      const programs = JSON.parse(fs.readFileSync(fpath, 'utf8'));
      for (const p of programs) {
        if (p.slug) map[p.slug] = sector;
      }
    } catch (_) {}
  }
  return map;
}

let _slugSectorMap = null;

router.get('/intern/opportunities', (req, res) => {
  if (!_slugSectorMap) _slugSectorMap = buildSlugSectorMap();

  // Support ?sector= filter (checks categories array, not just primary sector)
  const sectorFilter = req.query.sector || null;

  // Exclude job aggregator platforms from opportunity listings
  const EXCLUDE_SLUGS = new Set(['handshake', 'zintellect-orise']);

  const allPrograms = db.prepare('SELECT * FROM cdp_programs WHERE is_active = 1 ORDER BY created_at DESC').all();

  // Filter out passed deadlines and platform entries
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const programs = allPrograms.filter(p => {
    if (EXCLUDE_SLUGS.has(p.slug)) return false;
    if (!p.deadline) return true;
    const d = new Date(p.deadline);
    return isNaN(d.getTime()) || d >= today;
  });

  const opportunities = programs.map(p => {
    // Sector: use DB sector column if set, then pipeline map, then inference
    const primarySector = p.sector ||
      _slugSectorMap[p.slug] ||
      inferSector(p.slug, p.program_type, p.organization);

    // Categories: use DB categories column if set, else derive dynamically
    let categories;
    if (p.categories) {
      try { categories = JSON.parse(p.categories); } catch (_) { categories = [primarySector]; }
    } else {
      categories = deriveCategories(primarySector, p.slug, p.eligibility, p.program_type, p.stem_fields, p.organization);
    }

    const stipend = p.stipend || null;
    const isPaid = stipend ? !(/unpaid|volunteer|no stipend/i.test(stipend)) : false;

    let deadlineNotes = '';
    if (p.deadline) {
      try {
        const d = new Date(p.deadline);
        deadlineNotes = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      } catch (_) { deadlineNotes = p.deadline; }
    }

    const tags = [];
    if (p.eligibility) {
      try {
        const elig = typeof p.eligibility === 'string' ? JSON.parse(p.eligibility) : p.eligibility;
        if (elig.education_level && elig.education_level.includes('community-college')) tags.push('cc_friendly');
        if (elig.education_level && elig.education_level.includes('high-school')) tags.push('hs_eligible');
      } catch (_) {}
    }
    if (stipend && /housing/i.test(stipend)) tags.push('housing_provided');

    return {
      opportunity_id: p.slug,
      title: p.title,
      organization: p.organization,
      sector: primarySector,
      categories,
      category_labels: categories.map(c => SECTOR_LABELS[c] || c),
      description: p.description || '',
      stipend: stipend || 'See listing',
      deadline_notes: deadlineNotes,
      deadline: p.deadline || null,
      tags,
      url: p.url || null,
      application_url: p.url || null,
      is_paid: isPaid,
      location: p.location || null,
      remote: !!p.remote,
      program_type: p.program_type,
      stem_fields: p.stem_fields,
    };
  });

  // Apply sector filter — match if sector is in categories array
  const filtered = sectorFilter
    ? opportunities.filter(o => o.categories.includes(sectorFilter))
    : opportunities;

  res.json({
    opportunities: filtered,
    total: filtered.length,
    sectors: SECTOR_LABELS,
  });
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

// ── GET /students/me/full-data ──────────────────────────────
// Returns the full rich StudentData blob (localStorage-compatible format)

router.get('/students/me/full-data', authMiddleware, (req, res) => {
  const student = db.prepare(
    'SELECT uid, email, first_name, last_name, school, graduation_year, major, bio, linkedin_url, student_data_json, created_at FROM cdp_students WHERE uid = ?'
  ).get(req.student.uid);
  if (!student) return res.status(404).json({ error: 'Student not found' });

  // Parse stored JSON blob
  let stored = {};
  try { stored = student.student_data_json ? JSON.parse(student.student_data_json) : {}; } catch {}

  // Merge base profile fields with stored blob
  const result = {
    profile: {
      firstName: student.first_name || '',
      lastName: student.last_name || '',
      school: student.school || '',
      year: stored.profile?.year || '',
      major: student.major || '',
      gradYear: stored.profile?.gradYear || String(student.graduation_year || ''),
      email: student.email,
      createdAt: stored.profile?.createdAt || student.created_at,
      updatedAt: stored.profile?.updatedAt || student.created_at,
    },
    interests: stored.interests || [],
    skills: stored.skills || [],
    goals: stored.goals || [],
    targetTimeline: stored.targetTimeline || '',
    gpa: stored.gpa || null,
    experienceLevel: stored.experienceLevel || '',
    profileCompleteness: stored.profileCompleteness || 0,
    savedPrograms: stored.savedPrograms || [],
    gapAnalyses: stored.gapAnalyses || [],
    resumeUploaded: stored.resumeUploaded || false,
  };

  res.json(result);
});

// ── PUT /students/me/full-data ──────────────────────────────
// Saves the full StudentData blob

router.put('/students/me/full-data', authMiddleware, (req, res) => {
  const student = db.prepare('SELECT id FROM cdp_students WHERE uid = ?').get(req.student.uid);
  if (!student) return res.status(404).json({ error: 'Student not found' });

  const data = req.body;
  const json = JSON.stringify(data);

  // Also update top-level columns from profile
  db.prepare(`
    UPDATE cdp_students SET
      first_name      = COALESCE(?, first_name),
      last_name       = COALESCE(?, last_name),
      school          = COALESCE(?, school),
      major           = COALESCE(?, major),
      student_data_json = ?,
      updated_at      = datetime('now')
    WHERE uid = ?
  `).run(
    data.profile?.firstName || null,
    data.profile?.lastName || null,
    data.profile?.school || null,
    data.profile?.major || null,
    json,
    req.student.uid
  );

  res.json({ saved: true });
});

module.exports = router;
