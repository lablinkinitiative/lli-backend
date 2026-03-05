'use strict';

const express = require('express');
const { spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { authMiddleware } = require('./cdp-auth');
const db = require('../db/database');

const router = express.Router();

// ─── DB ───────────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS cdp_gap_analyses_v2 (
    id               TEXT PRIMARY KEY,
    student_uid      TEXT NOT NULL,
    pathway_id       TEXT NOT NULL,
    pathway_name     TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'queued',
    overall_match    INTEGER,
    readiness_level  TEXT,
    summary          TEXT,
    strengths        TEXT,
    gaps             TEXT,
    skill_breakdown  TEXT,
    recommendations  TEXT,
    radar_data       TEXT,
    timeline_est     TEXT,
    profile_snapshot TEXT,
    error            TEXT,
    auto_generated   INTEGER DEFAULT 0,
    created_at       TEXT DEFAULT (datetime('now')),
    updated_at       TEXT DEFAULT (datetime('now')),
    UNIQUE(student_uid, pathway_id)
  )
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_gap_v2_student ON cdp_gap_analyses_v2(student_uid)`);

// ─── Pathways data ────────────────────────────────────────────────────────────
let PATHWAYS = [];
try {
  const dataPath = path.join(__dirname, '..', '..', 'lli-cdp-app', 'src', 'data', 'pathways.json');
  if (fs.existsSync(dataPath)) {
    PATHWAYS = JSON.parse(fs.readFileSync(dataPath, 'utf8')).pathways || [];
  }
} catch {}
// Fallback: embed minimal pathway list so backend isn't dependent on frontend repo
if (PATHWAYS.length === 0) {
  PATHWAYS = [
    { id: 'doe-research-stem', name: 'DOE National Lab Research Internship', shortName: 'National Lab Research', track: 'STEM Research', description: 'Foundation pathway for DOE national lab research internships.', skills: [] },
    { id: 'ml-engineer', name: 'Machine Learning Engineer', shortName: 'ML Engineer', track: 'AI / Software', description: 'Build and deploy ML systems at scale.', skills: [] },
    { id: 'data-scientist', name: 'Data Scientist', shortName: 'Data Science', track: 'AI / Software', description: 'Extract insights from complex datasets.', skills: [] },
    { id: 'national-security-analyst', name: 'National Security Analyst', shortName: 'Nat Security', track: 'Government / Policy', description: 'Analyze threats and inform national security policy.', skills: [] },
    { id: 'energy-researcher', name: 'Clean Energy Researcher', shortName: 'Clean Energy', track: 'STEM Research', description: 'Research and develop clean energy technologies.', skills: [] },
  ];
}

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

    const timer = setTimeout(() => { child.kill(); reject(new Error('Claude timed out after ' + timeoutMs + 'ms')); }, timeoutMs);

    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`claude exited ${code}: ${stderr.slice(0, 400)}`));
      resolve(stdout);
    });

    child.on('error', err => { clearTimeout(timer); reject(err); });
  });
}

function buildGapPrompt(student, pathway) {
  const profile = {
    name: student.profile ? `${student.profile.firstName || ''} ${student.profile.lastName || ''}`.trim() : 'Student',
    school: student.profile?.school || null,
    year: student.profile?.year || null,
    major: student.profile?.major || null,
    gpa: student.gpa || null,
    gradYear: student.profile?.gradYear || null,
    skills: student.skills || [],
    interests: student.interests || [],
    goals: student.goals || [],
    targetTimeline: student.targetTimeline || null,
    experienceLevel: student.experienceLevel || null,
    experience: (student.experience || []).map(e => ({
      type: e.type, title: e.title, org: e.org, duration: e.duration, description: e.description, skills: e.skills || [],
    })),
  };

  const pw = {
    id: pathway.id,
    name: pathway.name,
    track: pathway.track,
    description: pathway.description,
    targetLevel: pathway.targetLevel,
    timeToReady: pathway.timeToReady,
    skills: (pathway.skills || []).map(s => ({ name: s.name, weight: s.weight, category: s.category })),
    careerOutcomes: pathway.careerOutcomes,
  };

  return `You are a STEM career advisor at LabLink Initiative, analyzing how well a student's profile matches a specific career pathway.

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
  "skill_breakdown": [
    {
      "skill": "<skill category name>",
      "studentLevel": <0.0-1.0>,
      "requiredLevel": <0.0-1.0>,
      "gap": <0.0-1.0>,
      "status": "<meets|partial|gap>",
      "rationale": "<1 sentence explaining the assessment>"
    }
  ],
  "recommendations": [
    {
      "priority": "<high|medium|low>",
      "text": "<specific, actionable recommendation referencing their situation>",
      "resource": "<URL if applicable, else null>"
    }
  ],
  "radar_data": {
    "axes": ["<category1>", "<category2>", "<category3>", "<category4>"],
    "studentScores": [<0.0-1.0>, <0.0-1.0>, <0.0-1.0>, <0.0-1.0>],
    "requiredScores": [<0.0-1.0>, <0.0-1.0>, <0.0-1.0>, <0.0-1.0>]
  },
  "timeline_est": "<realistic estimate like '2-3 semesters' or 'Ready now' or 'Competitive now with focused prep'>"
}

Rules:
- strengths: 2-4 items, specific to their actual profile
- gaps: 2-4 items, with context about what to do
- skill_breakdown: cover 4-6 major skill categories for this pathway
- recommendations: 5-7 items ordered by priority
- radar_data: exactly 4-6 axes, arrays must have same length
- overall_match: be honest — a student with no relevant skills should get 10-25, someone well-matched should get 70-90
- Be encouraging but accurate — distinguish "doesn't have it yet" from "incompatible trajectory"`;
}

// ─── Background analysis runner ───────────────────────────────────────────────
async function runAnalysis(analysisId, studentUid, pathway, autoGenerated) {
  try {
    db.prepare(`UPDATE cdp_gap_analyses_v2 SET status='processing', updated_at=datetime('now') WHERE id=?`).run(analysisId);

    const student = db.prepare('SELECT * FROM cdp_students WHERE uid=?').get(studentUid);
    if (!student) throw new Error('Student not found');

    const sd = student.student_data_json ? JSON.parse(student.student_data_json) : {};
    const prompt = buildGapPrompt(sd, pathway);
    const profileSnapshot = JSON.stringify(sd);

    const stdout = await spawnClaude(prompt, 120000);

    // Extract JSON — Claude sometimes wraps in markdown
    let jsonStr = stdout;
    const fence = stdout.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) jsonStr = fence[1];
    const rawMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (!rawMatch) throw new Error('No JSON in Claude response: ' + stdout.slice(0, 200));

    const result = JSON.parse(rawMatch[0]);

    // Validate required fields
    if (typeof result.overall_match !== 'number') throw new Error('Missing overall_match in response');
    if (!result.summary) throw new Error('Missing summary in response');

    // Clamp overall_match
    result.overall_match = Math.max(1, Math.min(100, Math.round(result.overall_match)));

    db.prepare(`
      UPDATE cdp_gap_analyses_v2
      SET status='complete',
          overall_match=?, readiness_level=?, summary=?,
          strengths=?, gaps=?, skill_breakdown=?,
          recommendations=?, radar_data=?, timeline_est=?,
          profile_snapshot=?, updated_at=datetime('now')
      WHERE id=?
    `).run(
      result.overall_match,
      result.readiness_level || 'building',
      result.summary,
      JSON.stringify(result.strengths || []),
      JSON.stringify(result.gaps || []),
      JSON.stringify(result.skill_breakdown || []),
      JSON.stringify(result.recommendations || []),
      JSON.stringify(result.radar_data || {}),
      result.timeline_est || null,
      profileSnapshot,
      analysisId
    );

    console.log(`[gap-analysis] ${analysisId} complete — ${pathway.name}, match=${result.overall_match}%`);
  } catch (err) {
    console.error('[gap-analysis] Failed:', analysisId, err.message);
    db.prepare(`UPDATE cdp_gap_analyses_v2 SET status='error', error=?, updated_at=datetime('now') WHERE id=?`)
      .run(err.message, analysisId);
  }
}

// ─── Per-student rate limiting for expensive AI operations ────────────────────
// Tracks how many /run requests a student has made in the current hour
const analysisRateLimiter = new Map(); // uid → { count, windowStart }
const ANALYSIS_MAX_PER_HOUR = 10;

function checkAnalysisRateLimit(uid) {
  const now = Date.now();
  const entry = analysisRateLimiter.get(uid);
  if (!entry || now - entry.windowStart > 3600000) {
    analysisRateLimiter.set(uid, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= ANALYSIS_MAX_PER_HOUR) return false;
  entry.count++;
  return true;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// POST /api/cdp/gap-analysis/run
router.post('/gap-analysis/run', authMiddleware, (req, res) => {
  const { pathway_id, force } = req.body;
  if (!pathway_id) return res.status(400).json({ error: 'pathway_id required' });

  if (!checkAnalysisRateLimit(req.student.uid)) {
    return res.status(429).json({ error: `Rate limit: max ${ANALYSIS_MAX_PER_HOUR} gap analyses per hour` });
  }

  // Look up from static list first, then fall back to cdp_pathways table (agent-generated)
  let pathway = PATHWAYS.find(p => p.id === pathway_id);
  if (!pathway) {
    const dbPw = db.prepare('SELECT * FROM cdp_pathways WHERE id=?').get(pathway_id);
    if (dbPw) {
      const req_json = (() => { try { return JSON.parse(dbPw.requirements_json || '{}'); } catch { return {}; } })();
      pathway = {
        id: dbPw.id,
        name: dbPw.title,
        shortName: dbPw.short_name,
        track: dbPw.career_field,
        description: dbPw.description,
        targetLevel: (dbPw.entry_level || '').split(','),
        timeToReady: null,
        skills: (req_json.skills || []).map(s => ({ name: s, weight: 3, category: 'General' })),
        careerOutcomes: (() => { try { return JSON.parse(dbPw.outcomes_json || '{}'); } catch { return {}; } })(),
      };
    }
  }
  if (!pathway) return res.status(404).json({ error: 'Pathway not found' });

  const studentUid = req.student.uid;

  // Check for recent cached analysis (within 7 days) unless force
  const existing = db.prepare(
    `SELECT id, status, overall_match, updated_at FROM cdp_gap_analyses_v2 WHERE student_uid=? AND pathway_id=?`
  ).get(studentUid, pathway_id);

  if (existing && !force) {
    const ageDays = (Date.now() - new Date(existing.updated_at).getTime()) / (1000 * 60 * 60 * 24);
    if (existing.status === 'complete' && ageDays < 7) {
      return res.json({ ok: true, job_id: existing.id, status: 'complete', cached: true });
    }
    if (existing.status === 'queued' || existing.status === 'processing') {
      return res.json({ ok: true, job_id: existing.id, status: existing.status });
    }
  }

  const analysisId = uuidv4();

  // Upsert — replace any existing record for this student+pathway
  db.prepare(`
    INSERT INTO cdp_gap_analyses_v2 (id, student_uid, pathway_id, pathway_name, status, auto_generated)
    VALUES (?, ?, ?, ?, 'queued', 0)
    ON CONFLICT(student_uid, pathway_id) DO UPDATE SET
      id=excluded.id, status='queued', error=NULL,
      overall_match=NULL, summary=NULL, strengths=NULL, gaps=NULL,
      skill_breakdown=NULL, recommendations=NULL, radar_data=NULL,
      timeline_est=NULL, auto_generated=0, updated_at=datetime('now')
  `).run(analysisId, studentUid, pathway_id, pathway.name);

  res.json({ ok: true, job_id: analysisId, status: 'queued' });

  setImmediate(() => {
    runAnalysis(analysisId, studentUid, pathway, false).catch(err => {
      console.error('[gap-analysis] Unhandled error:', err.message);
    });
  });
});

// GET /api/cdp/gap-analysis/status/:jobId
router.get('/gap-analysis/status/:jobId', authMiddleware, (req, res) => {
  const analysis = db.prepare(
    `SELECT id, pathway_id, pathway_name, status, overall_match, readiness_level, summary,
            strengths, gaps, skill_breakdown, recommendations, radar_data, timeline_est,
            auto_generated, error, created_at, updated_at
     FROM cdp_gap_analyses_v2 WHERE id=? AND student_uid=?`
  ).get(req.params.jobId, req.student.uid);

  if (!analysis) return res.status(404).json({ error: 'Analysis not found' });

  res.json(formatAnalysis(analysis));
});

// GET /api/cdp/gap-analyses — list all analyses for student
router.get('/gap-analyses', authMiddleware, (req, res) => {
  const analyses = db.prepare(
    `SELECT id, pathway_id, pathway_name, status, overall_match, readiness_level,
            auto_generated, error, created_at, updated_at
     FROM cdp_gap_analyses_v2 WHERE student_uid=? ORDER BY updated_at DESC`
  ).all(req.student.uid);

  res.json({ ok: true, analyses: analyses.map(a => ({
    id: a.id,
    pathwayId: a.pathway_id,
    pathwayName: a.pathway_name,
    status: a.status,
    overallMatch: a.overall_match,
    readinessLevel: a.readiness_level,
    autoGenerated: !!a.auto_generated,
    error: a.error,
    createdAt: a.created_at,
    updatedAt: a.updated_at,
  })) });
});

// GET /api/cdp/gap-analysis/:id — full detail
router.get('/gap-analysis/:id', authMiddleware, (req, res) => {
  const analysis = db.prepare(
    `SELECT * FROM cdp_gap_analyses_v2 WHERE id=? AND student_uid=?`
  ).get(req.params.id, req.student.uid);

  if (!analysis) return res.status(404).json({ error: 'Analysis not found' });

  res.json({ ok: true, analysis: formatAnalysis(analysis) });
});

// DELETE /api/cdp/gap-analysis/:id
router.delete('/gap-analysis/:id', authMiddleware, (req, res) => {
  const analysis = db.prepare(`SELECT id FROM cdp_gap_analyses_v2 WHERE id=? AND student_uid=?`)
    .get(req.params.id, req.student.uid);
  if (!analysis) return res.status(404).json({ error: 'Analysis not found' });

  db.prepare(`DELETE FROM cdp_gap_analyses_v2 WHERE id=?`).run(req.params.id);
  res.json({ ok: true });
});

// POST /api/cdp/gap-analysis/auto-init — queue top-3 pathway analyses
router.post('/gap-analysis/auto-init', authMiddleware, (req, res) => {
  const studentUid = req.student.uid;
  const student = db.prepare('SELECT * FROM cdp_students WHERE uid=?').get(studentUid);
  if (!student) return res.status(404).json({ error: 'Student not found' });

  const sd = student.student_data_json ? JSON.parse(student.student_data_json) : {};
  const completeness = sd.profileCompleteness || 0;

  if (completeness < 60) {
    return res.json({ ok: true, queued: 0, message: 'Profile completeness < 60%, skipping auto-init' });
  }

  // Pick top 3 pathways by interest alignment (simple heuristic)
  const interests = (sd.interests || []).map(i => i.toLowerCase());
  const skills = (sd.skills || []).map(s => s.toLowerCase());

  const scored = PATHWAYS.map(pathway => {
    let score = 0;
    const pw = JSON.stringify(pathway).toLowerCase();
    for (const interest of interests) {
      if (pw.includes(interest.split(' ')[0])) score += 2;
    }
    for (const skill of skills) {
      const skillLow = skill.toLowerCase();
      if ((pathway.skills || []).some(s => s.name.toLowerCase().includes(skillLow))) score += 1;
    }
    return { pathway, score };
  }).sort((a, b) => b.score - a.score).slice(0, 3);

  const queued = [];
  for (const { pathway } of scored) {
    // Only queue if no recent complete analysis exists
    const existing = db.prepare(
      `SELECT id, status FROM cdp_gap_analyses_v2 WHERE student_uid=? AND pathway_id=?`
    ).get(studentUid, pathway.id);

    if (existing && (existing.status === 'complete' || existing.status === 'queued' || existing.status === 'processing')) {
      continue;
    }

    const analysisId = uuidv4();
    db.prepare(`
      INSERT INTO cdp_gap_analyses_v2 (id, student_uid, pathway_id, pathway_name, status, auto_generated)
      VALUES (?, ?, ?, ?, 'queued', 1)
      ON CONFLICT(student_uid, pathway_id) DO UPDATE SET
        id=excluded.id, status='queued', error=NULL, auto_generated=1, updated_at=datetime('now')
    `).run(analysisId, studentUid, pathway.id, pathway.name);

    queued.push({ analysisId, pathway });
  }

  res.json({ ok: true, queued: queued.length, pathways: queued.map(q => q.pathway.name) });

  // Start background jobs
  for (const { analysisId, pathway } of queued) {
    setImmediate(() => {
      runAnalysis(analysisId, studentUid, pathway, true).catch(err => {
        console.error('[gap-analysis] Auto-init error:', err.message);
      });
    });
  }
});

// ─── Format helper ────────────────────────────────────────────────────────────
function formatAnalysis(a) {
  const parse = (field) => {
    if (!field) return null;
    try { return JSON.parse(field); } catch { return field; }
  };

  return {
    id: a.id,
    pathwayId: a.pathway_id,
    pathwayName: a.pathway_name,
    status: a.status,
    overallMatch: a.overall_match,
    readinessLevel: a.readiness_level,
    summary: a.summary,
    strengths: parse(a.strengths) || [],
    gaps: parse(a.gaps) || [],
    skillBreakdown: parse(a.skill_breakdown) || [],
    recommendations: parse(a.recommendations) || [],
    radarData: parse(a.radar_data) || { axes: [], studentScores: [], requiredScores: [] },
    timelineEst: a.timeline_est,
    autoGenerated: !!a.auto_generated,
    error: a.error,
    createdAt: a.created_at,
    updatedAt: a.updated_at,
  };
}

module.exports = router;
