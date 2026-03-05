'use strict';

/**
 * Pathway Intelligence System v2
 * Routes: /api/cdp/pathways/* and /api/cdp/students/me/pathways/*
 *
 * Architecture:
 *  - cdp_pathways: shared library of career pathways (seeded + agent-generated)
 *  - cdp_student_pathways: per-student assignments (3 tiers: high/medium/stretch)
 *  - cdp_pathway_programs: many-to-many program ↔ pathway mapping
 *
 * Key design principle: prefer genuine matches over force-fitting.
 * Prefer creating new pathways over force-fitting existing ones into wrong tiers.
 */

const express = require('express');
const { spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { authMiddleware } = require('./cdp-auth');
const db = require('../db/database');

const router = express.Router();

// ─── DB Setup ────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS cdp_pathways (
    id                 TEXT PRIMARY KEY,
    title              TEXT NOT NULL,
    short_name         TEXT,
    description        TEXT,
    career_field       TEXT,
    entry_level        TEXT,
    requirements_json  TEXT,
    outcomes_json      TEXT,
    keywords           TEXT,
    research_json      TEXT,
    seeded_from        TEXT DEFAULT 'agent',
    created_by         TEXT DEFAULT 'agent',
    created_at         TEXT DEFAULT (datetime('now')),
    last_researched_at TEXT,
    usage_count        INTEGER DEFAULT 0
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS cdp_student_pathways (
    id                   TEXT PRIMARY KEY,
    student_uid          TEXT NOT NULL,
    pathway_id           TEXT NOT NULL,
    fit_score            INTEGER,
    fit_tier             TEXT,
    gap_analysis_id      TEXT,
    assigned_at          TEXT DEFAULT (datetime('now')),
    is_default           INTEGER DEFAULT 1,
    profile_snapshot_hash TEXT,
    notes                TEXT
  )
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_sp_student ON cdp_student_pathways(student_uid)`);

db.exec(`
  CREATE TABLE IF NOT EXISTS cdp_pathway_programs (
    pathway_id       TEXT NOT NULL,
    program_id       INTEGER NOT NULL,
    relevance_score  INTEGER DEFAULT 50,
    mapped_by        TEXT DEFAULT 'auto',
    mapped_at        TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (pathway_id, program_id)
  )
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_pp_pathway ON cdp_pathway_programs(pathway_id)`);

// Job tracking (in-memory; jobs are fast enough)
const generationJobs = new Map(); // jobId → {status, pathways, error}

// ─── Claude helpers ───────────────────────────────────────────────────────────

const CLAUDE_BIN = '/home/agent/.local/bin/claude';

function getClaudeToken() {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return process.env.CLAUDE_CODE_OAUTH_TOKEN;
  try { return fs.readFileSync(os.homedir() + '/.claude-token', 'utf8').trim(); } catch { return null; }
}

function spawnClaude(prompt, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.CLAUDECODE;
    const token = getClaudeToken();
    if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token;

    const child = spawn(CLAUDE_BIN, [
      '--print', '--dangerously-skip-permissions', '--output-format', 'text', prompt
    ], { env, stdio: ['pipe', 'pipe', 'pipe'] });

    child.stdin.end();

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Claude timed out after ' + timeoutMs + 'ms'));
    }, timeoutMs);

    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`claude exited ${code}: ${stderr.slice(0, 400)}`));
      resolve(stdout);
    });

    child.on('error', err => { clearTimeout(timer); reject(err); });
  });
}

function extractJSON(text) {
  // Try raw parse first
  try { return JSON.parse(text.trim()); } catch {}
  // Strip markdown fences
  const m = text.match(/```(?:json)?\s*([\s\S]+?)```/);
  if (m) { try { return JSON.parse(m[1].trim()); } catch {} }
  // Find first { ... }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end !== -1) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch {}
  }
  throw new Error('Could not extract JSON from: ' + text.slice(0, 200));
}

// ─── Profile helpers ──────────────────────────────────────────────────────────

function parseStudentData(student) {
  try {
    return student.student_data_json ? JSON.parse(student.student_data_json) : {};
  } catch { return {}; }
}

function computeCompleteness(sd) {
  let score = 0;
  if (sd.profile?.firstName) score += 10;
  if (sd.profile?.lastName) score += 5;
  if (sd.profile?.school) score += 10;
  if (sd.profile?.year) score += 10;
  if (sd.profile?.major) score += 10;
  if (sd.interests?.length > 0) score += 15;
  if (sd.skills?.length > 0) score += 10;
  if (sd.goals?.length > 0) score += 10;
  if (sd.targetTimeline) score += 5;
  if (sd.gpa) score += 5;
  if (sd.resumeUploaded) score += 5;
  if (sd.experience?.length > 0) score += 5;
  return Math.min(100, score);
}

function profileHash(sd) {
  const key = JSON.stringify({
    skills: (sd.skills || []).slice().sort(),
    interests: (sd.interests || []).slice().sort(),
    goals: (sd.goals || []).slice().sort(),
    school: sd.profile?.school,
    year: sd.profile?.year,
    major: sd.profile?.major,
  });
  // Simple hash
  let h = 0;
  for (let i = 0; i < key.length; i++) {
    h = (h << 5) - h + key.charCodeAt(i);
    h |= 0;
  }
  return String(h);
}

// ─── Pathway search helpers ───────────────────────────────────────────────────

function searchPathways({ keywords = '', career_field = '', entry_level = '', limit = 30 } = {}) {
  let sql = 'SELECT * FROM cdp_pathways WHERE 1=1';
  const params = [];

  if (career_field) {
    sql += ' AND career_field LIKE ?';
    params.push(`%${career_field}%`);
  }
  if (entry_level) {
    sql += ' AND entry_level LIKE ?';
    params.push(`%${entry_level}%`);
  }
  if (keywords) {
    const kws = keywords.split(/[,\s]+/).filter(Boolean).slice(0, 10);
    const conditions = kws.map(() => '(keywords LIKE ? OR title LIKE ? OR description LIKE ?)').join(' OR ');
    sql += ` AND (${conditions})`;
    for (const kw of kws) {
      params.push(`%${kw}%`, `%${kw}%`, `%${kw}%`);
    }
  }

  sql += ' ORDER BY usage_count DESC LIMIT ?';
  params.push(Number(limit) || 30);

  return db.prepare(sql).all(...params);
}

function mapProgramsToPathway(pathwayId, keywords) {
  if (!keywords) return;
  const kws = keywords.split(',').map(k => k.trim()).filter(Boolean).slice(0, 8);
  if (!kws.length) return;

  const conditions = kws.map(() => '(title LIKE ? OR stem_fields LIKE ? OR description LIKE ? OR tags LIKE ?)').join(' OR ');
  const params = [];
  for (const kw of kws) {
    params.push(`%${kw}%`, `%${kw}%`, `%${kw}%`, `%${kw}%`);
  }

  const programs = db.prepare(
    `SELECT id, title FROM cdp_programs WHERE is_active=1 AND (${conditions}) LIMIT 20`
  ).all(...params);

  const insert = db.prepare(`
    INSERT OR IGNORE INTO cdp_pathway_programs (pathway_id, program_id, relevance_score, mapped_by)
    VALUES (?, ?, ?, 'auto')
  `);

  for (const prog of programs) {
    // Basic relevance: count how many keywords match
    const matchCount = kws.filter(kw => {
      const t = (prog.title || '').toLowerCase();
      return t.includes(kw.toLowerCase());
    }).length;
    const relevance = Math.min(95, 50 + matchCount * 15);
    insert.run(pathwayId, prog.id, relevance);
  }

  return programs.length;
}

// ─── Claude scoring prompt ────────────────────────────────────────────────────

function buildScoringPrompt(student, candidates) {
  const profile = {
    name: `${student.profile?.firstName || ''} ${student.profile?.lastName || ''}`.trim(),
    school: student.profile?.school,
    year: student.profile?.year,
    major: student.profile?.major,
    gpa: student.gpa,
    skills: student.skills || [],
    interests: student.interests || [],
    goals: student.goals || [],
    targetTimeline: student.targetTimeline,
    experienceLevel: student.experienceLevel,
    experience: (student.experience || []).map(e => ({
      type: e.type, title: e.title, org: e.org, description: e.description
    })),
  };

  return `You are a STEM career advisor scoring how well a student's profile fits various career pathways.

STUDENT PROFILE:
${JSON.stringify(profile, null, 2)}

CANDIDATE PATHWAYS (${candidates.length} total):
${JSON.stringify(candidates.map(c => ({
  id: c.id,
  title: c.title,
  career_field: c.career_field,
  entry_level: c.entry_level,
  keywords: c.keywords,
  requirements: (() => { try { return JSON.parse(c.requirements_json || '{}'); } catch { return {}; } })(),
})), null, 2)}

TASK:
Score each pathway for this student. For each pathway, provide a fit_score (0-100) and
indicate whether it's a GENUINE match (is_genuine_match=true) or a FORCED fit (false).

TIER DEFINITIONS:
- High tier (genuine): fit_score 75-95, student's background NATURALLY aligns with this pathway
- Medium tier (genuine): fit_score 45-70, clear path with 6-12 months of targeted work
- Stretch tier (genuine): fit_score 15-40, ambitious but realistic in 2-3 years

CRITICAL INSTRUCTIONS — READ CAREFULLY:
1. PREFER GENUINE MATCHES over force-fitting. If no pathway truly fits a tier, set is_genuine_match=false.
   The system will generate a custom pathway for that tier — that's better than a bad fit.
2. DO NOT mark is_genuine_match=true just to fill all three tiers. It's fine to have all false
   if none of the candidates genuinely serve the student.
3. ALSO DO NOT always create new — if a strong match exists (score well above the tier minimum),
   assign it. Save generation for when no real match exists.
4. Assess based on: what the student has DONE (experience), not just listed keywords.
5. One-line reasoning should explain WHY it's genuine or not.

Return ONLY a valid JSON array (no markdown, no explanation):
[
  {
    "pathway_id": "<id>",
    "fit_score": <0-100>,
    "tier": "<high|medium|stretch|none>",
    "is_genuine_match": <true|false>,
    "reasoning": "<one sentence explaining the assessment>"
  }
]

Every candidate pathway must appear in the output array exactly once.`;
}

// ─── Generation job runner ────────────────────────────────────────────────────

async function runGeneration(jobId, studentUid, sd) {
  const job = generationJobs.get(jobId);
  if (!job) return;

  try {
    job.status = 'running';

    // Step 1: Build student keywords
    const keywords = [
      ...(sd.skills || []),
      ...(sd.interests || []),
      ...(sd.goals || []),
      sd.profile?.major,
    ].filter(Boolean).join(' ');

    const entryLevel = sd.profile?.year || '';

    // Step 2: Search pathway library
    const candidates = searchPathways({ keywords, entry_level: entryLevel, limit: 30 });

    let scoredPathways = [];

    if (candidates.length > 0) {
      // Step 3: Claude scores candidates (ONE call)
      const scoringPrompt = buildScoringPrompt(sd, candidates);
      let scoringOutput;
      try {
        scoringOutput = await spawnClaude(scoringPrompt, 120000);
        scoredPathways = extractJSON(scoringOutput);
        if (!Array.isArray(scoredPathways)) scoredPathways = [];
      } catch (e) {
        console.error('Scoring call failed:', e.message);
        scoredPathways = [];
      }
    }

    // Step 4: Tier selection — find best genuine match per tier
    const tiers = { high: null, medium: null, stretch: null };
    const tierRanges = {
      high: [75, 100],
      medium: [45, 74],
      stretch: [15, 44],
    };

    for (const tier of ['high', 'medium', 'stretch']) {
      const [min, max] = tierRanges[tier];
      const genuine = scoredPathways
        .filter(s => s.is_genuine_match && s.fit_score >= min && s.fit_score <= max)
        .sort((a, b) => b.fit_score - a.fit_score);

      if (genuine.length > 0) {
        tiers[tier] = genuine[0];
      }
    }

    // Step 5: Generate missing tiers
    for (const tier of ['high', 'medium', 'stretch']) {
      if (tiers[tier]) continue;

      const targetFit = tier === 'high' ? 82 : tier === 'medium' ? 58 : 25;
      const generatePrompt = `You are building a career pathway for a STEM student who needs a "${tier}" career pathway.

STUDENT PROFILE:
${JSON.stringify({
  skills: sd.skills || [],
  interests: sd.interests || [],
  goals: sd.goals || [],
  major: sd.profile?.major,
  year: sd.profile?.year,
  experience: (sd.experience || []).map(e => ({ title: e.title, org: e.org })),
}, null, 2)}

TASK: Create a career pathway that is a GENUINE "${tier}" fit for this student at approximately ${targetFit}% match.
- "high" = they have most of what's needed, need 2-4 focused steps
- "medium" = clear path with 6-12 months of targeted work
- "stretch" = ambitious goal, possible in 2-3 years

Return ONLY a valid JSON object (no markdown):
{
  "id": "<kebab-case-unique-id>",
  "title": "<specific career title, e.g. 'Computational Biologist at NIH'>",
  "short_name": "<3-4 word label>",
  "description": "<2-3 sentence description of this career path>",
  "career_field": "<STEM Research|Computing & Data|Policy|Business|etc>",
  "entry_level": "<comma-separated list: high_school,undergraduate,community_college,graduate>",
  "keywords": "<10-15 relevant keywords, comma-separated>",
  "requirements": {
    "skills": ["<required skill 1>", "<required skill 2>"],
    "education": ["<education requirement>"],
    "experience": ["<experience requirement>"]
  },
  "outcomes": {
    "roles": ["<job title 1>", "<job title 2>"],
    "salary_range": "<e.g. $65,000 - $90,000>",
    "growth_outlook": "<Positive|Strong|Excellent>",
    "top_employers": ["<employer 1>", "<employer 2>", "<employer 3>"]
  },
  "fit_score": ${targetFit},
  "fit_reasoning": "<one sentence explaining why this is a ${tier} fit for this student>"
}`;

      try {
        const genOutput = await spawnClaude(generatePrompt, 90000);
        const newPw = extractJSON(genOutput);

        if (!newPw.id || !newPw.title) throw new Error('Invalid pathway generated');

        // Ensure unique ID
        const existingIds = db.prepare('SELECT id FROM cdp_pathways WHERE id=?').get(newPw.id);
        if (existingIds) newPw.id = newPw.id + '-' + Date.now();

        // Save to library
        db.prepare(`
          INSERT OR IGNORE INTO cdp_pathways
          (id, title, short_name, description, career_field, entry_level,
           requirements_json, outcomes_json, keywords, created_by, seeded_from)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'agent', 'agent')
        `).run(
          newPw.id, newPw.title, newPw.short_name, newPw.description,
          newPw.career_field, newPw.entry_level,
          JSON.stringify(newPw.requirements || {}),
          JSON.stringify(newPw.outcomes || {}),
          newPw.keywords || '',
        );

        // Map programs
        mapProgramsToPathway(newPw.id, newPw.keywords || '');

        tiers[tier] = {
          pathway_id: newPw.id,
          fit_score: newPw.fit_score || targetFit,
          tier,
          is_genuine_match: true,
          reasoning: newPw.fit_reasoning || `Generated ${tier} pathway for this student.`,
        };
      } catch (e) {
        console.error(`Failed to generate ${tier} pathway:`, e.message);
        // Try to find any pathway as fallback
        const anyPw = db.prepare('SELECT * FROM cdp_pathways ORDER BY RANDOM() LIMIT 1').get();
        if (anyPw) {
          tiers[tier] = {
            pathway_id: anyPw.id,
            fit_score: tier === 'high' ? 75 : tier === 'medium' ? 50 : 20,
            tier,
            is_genuine_match: false,
            reasoning: 'Fallback assignment — generation failed.',
          };
        }
      }
    }

    // Step 6: Assign to student_pathways
    const hash = profileHash(sd);

    // Remove existing default assignments for re-generation
    db.prepare(`DELETE FROM cdp_student_pathways WHERE student_uid=? AND is_default=1`).run(studentUid);

    const assigned = [];
    for (const [tier, result] of Object.entries(tiers)) {
      if (!result) continue;

      const pathwayId = result.pathway_id || result.pathway_id;
      const id = uuidv4();

      db.prepare(`
        INSERT INTO cdp_student_pathways
        (id, student_uid, pathway_id, fit_score, fit_tier, assigned_at, is_default, profile_snapshot_hash, notes)
        VALUES (?, ?, ?, ?, ?, datetime('now'), 1, ?, ?)
      `).run(id, studentUid, pathwayId, result.fit_score, tier, hash, result.reasoning || '');

      // Increment usage count
      db.prepare('UPDATE cdp_pathways SET usage_count=usage_count+1 WHERE id=?').run(pathwayId);

      // Map programs to this pathway
      const pw = db.prepare('SELECT keywords FROM cdp_pathways WHERE id=?').get(pathwayId);
      if (pw?.keywords) mapProgramsToPathway(pathwayId, pw.keywords);

      assigned.push({ id, pathway_id: pathwayId, fit_score: result.fit_score, fit_tier: tier, notes: result.reasoning });
    }

    // Step 7: Queue gap analyses for each assigned pathway
    for (const assignment of assigned) {
      const pw = db.prepare('SELECT * FROM cdp_pathways WHERE id=?').get(assignment.pathway_id);
      if (!pw) continue;

      // Build minimal pathway object compatible with gap analysis route
      const pathwayForGap = {
        id: pw.id,
        name: pw.title,
        shortName: pw.short_name,
        track: pw.career_field,
        description: pw.description,
        targetLevel: (pw.entry_level || '').split(','),
        timeToReady: null,
        skills: (() => {
          try {
            const req = JSON.parse(pw.requirements_json || '{}');
            return (req.skills || []).map(s => ({ name: s, weight: 3, category: 'General' }));
          } catch { return []; }
        })(),
      };

      // Check if analysis exists
      const existing = db.prepare(
        'SELECT id FROM cdp_gap_analyses_v2 WHERE student_uid=? AND pathway_id=?'
      ).get(studentUid, pw.id);

      if (!existing) {
        const analysisId = uuidv4();
        db.prepare(`
          INSERT INTO cdp_gap_analyses_v2
          (id, student_uid, pathway_id, pathway_name, status, auto_generated)
          VALUES (?, ?, ?, ?, 'queued', 1)
        `).run(analysisId, studentUid, pw.id, pw.title);

        // Update assignment with gap_analysis_id
        db.prepare('UPDATE cdp_student_pathways SET gap_analysis_id=? WHERE id=?')
          .run(analysisId, assignment.id);

        // Trigger gap analysis async (import-style call to the gap analysis runner)
        // We'll trigger via a lightweight internal call
        setImmediate(() => {
          triggerGapAnalysis(analysisId, studentUid, pathwayForGap).catch(e =>
            console.error('Gap analysis trigger failed:', e.message)
          );
        });
      }
    }

    job.status = 'complete';
    job.pathways = assigned;
  } catch (e) {
    console.error('Generation job error:', e.message);
    job.status = 'error';
    job.error = e.message;
  }
}

// Lightweight gap analysis trigger (mirrors cdp-gap-analysis runAnalysis)
async function triggerGapAnalysis(analysisId, studentUid, pathway) {
  const CLAUDE_BIN = '/home/agent/.local/bin/claude';

  try {
    db.prepare(`UPDATE cdp_gap_analyses_v2 SET status='processing', updated_at=datetime('now') WHERE id=?`).run(analysisId);

    const student = db.prepare('SELECT * FROM cdp_students WHERE uid=?').get(studentUid);
    if (!student) throw new Error('Student not found');

    const sd = student.student_data_json ? JSON.parse(student.student_data_json) : {};

    const profile = {
      name: `${sd.profile?.firstName || ''} ${sd.profile?.lastName || ''}`.trim(),
      school: sd.profile?.school, year: sd.profile?.year, major: sd.profile?.major,
      gpa: sd.gpa, skills: sd.skills || [], interests: sd.interests || [],
      goals: sd.goals || [], targetTimeline: sd.targetTimeline,
      experienceLevel: sd.experienceLevel,
      experience: (sd.experience || []).map(e => ({
        type: e.type, title: e.title, org: e.org, description: e.description,
      })),
    };

    const pw = {
      id: pathway.id, name: pathway.name, track: pathway.track,
      description: pathway.description, targetLevel: pathway.targetLevel,
      timeToReady: pathway.timeToReady,
      skills: (pathway.skills || []).map(s => ({ name: s.name, weight: s.weight, category: s.category })),
    };

    const prompt = `You are a STEM career advisor at LabLink Initiative, analyzing how well a student's profile matches a specific career pathway.

STUDENT PROFILE:
${JSON.stringify(profile, null, 2)}

CAREER PATHWAY:
${JSON.stringify(pw, null, 2)}

TASK:
Analyze this student's readiness for this pathway. Think carefully about:
- What they've actually DONE (experience entries) vs what they've listed (skills keywords)
- Whether their academic trajectory suggests potential even if current skills don't match keywords
- The QUALITY of their experience, not just presence/absence of keywords
- Their stated goals alignment with this pathway's outcomes
- Practical next steps specific to THEIR situation

Return ONLY a valid JSON object (no markdown fences, no explanation, just raw JSON starting with {):
{
  "overall_match": <integer 1-100>,
  "readiness_level": "<early_stage|building|ready|strong_candidate>",
  "summary": "<2-3 sentences explaining the match holistically, referencing the student's actual background>",
  "strengths": ["<specific strength based on their profile>"],
  "gaps": ["<specific gap with context about why it matters for this pathway>"],
  "skill_breakdown": [{"skill":"<category>","studentLevel":<0.0-1.0>,"requiredLevel":<0.0-1.0>,"gap":<0.0-1.0>,"status":"<meets|partial|gap>","rationale":"<1 sentence>"}],
  "recommendations": [{"priority":"<high|medium|low>","text":"<actionable recommendation>","resource":"<URL or null>"}],
  "radar_data": {"axes":["<cat1>","<cat2>","<cat3>","<cat4>"],"studentScores":[<0.0-1.0>,...],"requiredScores":[<0.0-1.0>,...]}  ,
  "timeline_est": "<realistic estimate>"
}

Rules: strengths 2-4 items, gaps 2-4 items, skill_breakdown 4-6 items, recommendations 5-7 items, radar_data exactly 4-6 axes with matching array lengths.`;

    const profileSnapshot = JSON.stringify(sd);
    const stdout = await spawnClaude(prompt, 120000);

    let result;
    try {
      result = extractJSON(stdout);
    } catch {
      // Try once more with explicit prompt
      const retryPrompt = prompt + '\n\nIMPORTANT: Return ONLY raw JSON starting with { — no markdown, no explanation.';
      const stdout2 = await spawnClaude(retryPrompt, 60000);
      result = extractJSON(stdout2);
    }

    db.prepare(`
      UPDATE cdp_gap_analyses_v2 SET
        status='complete', overall_match=?, readiness_level=?, summary=?, strengths=?, gaps=?,
        skill_breakdown=?, recommendations=?, radar_data=?, timeline_est=?, profile_snapshot=?,
        updated_at=datetime('now')
      WHERE id=?
    `).run(
      result.overall_match, result.readiness_level, result.summary,
      JSON.stringify(result.strengths), JSON.stringify(result.gaps),
      JSON.stringify(result.skill_breakdown), JSON.stringify(result.recommendations),
      JSON.stringify(result.radar_data), result.timeline_est, profileSnapshot,
      analysisId,
    );
  } catch (e) {
    db.prepare(`UPDATE cdp_gap_analyses_v2 SET status='error', error=?, updated_at=datetime('now') WHERE id=?`)
      .run(e.message, analysisId);
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// GET /api/cdp/pathways — browse all pathways
router.get('/pathways', (req, res) => {
  const { career_field, entry_level, search, limit = 50 } = req.query;
  const pathways = searchPathways({
    keywords: search || '',
    career_field: career_field || '',
    entry_level: entry_level || '',
    limit: Math.min(Number(limit) || 50, 100),
  });

  res.json({
    ok: true,
    count: pathways.length,
    pathways: pathways.map(p => ({
      id: p.id,
      title: p.title,
      short_name: p.short_name,
      description: p.description,
      career_field: p.career_field,
      entry_level: p.entry_level,
      keywords: p.keywords,
      usage_count: p.usage_count,
      seeded_from: p.seeded_from,
    })),
  });
});

// GET /api/cdp/pathways/search — keyword search (used by scoring pipeline)
router.get('/pathways/search', (req, res) => {
  const { keywords, career_field, entry_level, limit } = req.query;
  const results = searchPathways({ keywords, career_field, entry_level, limit: Math.min(Number(limit) || 30, 50) });
  res.json({ ok: true, count: results.length, pathways: results });
});

// GET /api/cdp/pathways/:id — single pathway detail
router.get('/pathways/:id', (req, res) => {
  const pw = db.prepare('SELECT * FROM cdp_pathways WHERE id=?').get(req.params.id);
  if (!pw) return res.status(404).json({ error: 'Pathway not found' });

  // Get mapped programs
  const programs = db.prepare(`
    SELECT p.id, p.title, p.organization, p.sector, p.tags, p.deadline, p.remote, pp.relevance_score
    FROM cdp_pathway_programs pp
    JOIN cdp_programs p ON p.id=pp.program_id
    WHERE pp.pathway_id=? AND p.is_active=1
    ORDER BY pp.relevance_score DESC
    LIMIT 20
  `).all(pw.id);

  res.json({
    ok: true,
    pathway: {
      ...pw,
      requirements: (() => { try { return JSON.parse(pw.requirements_json || '{}'); } catch { return {}; } })(),
      outcomes: (() => { try { return JSON.parse(pw.outcomes_json || '{}'); } catch { return {}; } })(),
      research: (() => { try { return JSON.parse(pw.research_json || 'null'); } catch { return null; } })(),
      programs,
    },
  });
});

// POST /api/cdp/pathways/score — batch score pathways vs student profile (internal tool)
router.post('/pathways/score', authMiddleware, async (req, res) => {
  const { pathway_ids } = req.body;
  if (!Array.isArray(pathway_ids) || !pathway_ids.length) {
    return res.status(400).json({ error: 'pathway_ids must be a non-empty array' });
  }

  const student = db.prepare('SELECT * FROM cdp_students WHERE uid=?').get(req.student.uid);
  if (!student) return res.status(404).json({ error: 'Student not found' });
  const sd = parseStudentData(student);

  const candidates = pathway_ids
    .map(id => db.prepare('SELECT * FROM cdp_pathways WHERE id=?').get(id))
    .filter(Boolean);

  if (!candidates.length) return res.status(404).json({ error: 'No valid pathways found' });

  try {
    const prompt = buildScoringPrompt(sd, candidates);
    const output = await spawnClaude(prompt, 90000);
    const scores = extractJSON(output);
    res.json({ ok: true, scores });
  } catch (e) {
    res.status(500).json({ error: 'Scoring failed: ' + e.message });
  }
});

// GET /api/cdp/students/me/pathways — get student's assigned pathways
router.get('/students/me/pathways', authMiddleware, (req, res) => {
  const assignments = db.prepare(`
    SELECT sp.*, p.title, p.short_name, p.description, p.career_field, p.keywords
    FROM cdp_student_pathways sp
    JOIN cdp_pathways p ON p.id=sp.pathway_id
    WHERE sp.student_uid=?
    ORDER BY CASE sp.fit_tier WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'stretch' THEN 3 ELSE 4 END
  `).all(req.student.uid);

  const result = assignments.map(a => {
    // Get gap analysis status if linked
    let gapAnalysis = null;
    if (a.gap_analysis_id) {
      const ga = db.prepare('SELECT id, status, overall_match, readiness_level, summary FROM cdp_gap_analyses_v2 WHERE id=?').get(a.gap_analysis_id);
      gapAnalysis = ga || null;
    }

    // Get mapped programs count
    const progCount = db.prepare('SELECT COUNT(*) as c FROM cdp_pathway_programs WHERE pathway_id=?').get(a.pathway_id);

    return {
      id: a.id,
      pathway_id: a.pathway_id,
      title: a.title,
      short_name: a.short_name,
      description: a.description,
      career_field: a.career_field,
      fit_score: a.fit_score,
      fit_tier: a.fit_tier,
      notes: a.notes,
      is_default: !!a.is_default,
      assigned_at: a.assigned_at,
      gap_analysis: gapAnalysis,
      mapped_programs_count: progCount?.c || 0,
    };
  });

  res.json({ ok: true, pathways: result });
});

// POST /api/cdp/students/me/pathways/generate — trigger 3-pathway generation
router.post('/students/me/pathways/generate', authMiddleware, async (req, res) => {
  const student = db.prepare('SELECT * FROM cdp_students WHERE uid=?').get(req.student.uid);
  if (!student) return res.status(404).json({ error: 'Student not found' });

  const sd = parseStudentData(student);
  const completeness = computeCompleteness(sd);

  if (completeness < 60) {
    return res.status(400).json({
      error: 'Profile not complete enough',
      message: `Profile is ${completeness}% complete. Reach 60% to unlock pathway generation.`,
      completeness,
    });
  }

  const jobId = uuidv4();
  generationJobs.set(jobId, { status: 'pending', pathways: null, error: null });

  // Run async
  setImmediate(() => runGeneration(jobId, req.student.uid, sd).catch(e => {
    const job = generationJobs.get(jobId);
    if (job) { job.status = 'error'; job.error = e.message; }
  }));

  res.json({ ok: true, job_id: jobId, message: 'Pathway generation started' });
});

// GET /api/cdp/students/me/pathways/status/:jobId — poll generation status
router.get('/students/me/pathways/status/:jobId', authMiddleware, (req, res) => {
  const job = generationJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  res.json({
    ok: true,
    status: job.status,
    pathways: job.pathways || null,
    error: job.error || null,
  });
});

module.exports = router;
