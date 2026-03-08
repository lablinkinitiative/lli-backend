'use strict';

const express = require('express');
const multer = require('multer');
const { spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Read auth token for spawning Claude subprocess
function getClaudeToken() {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return process.env.CLAUDE_CODE_OAUTH_TOKEN;
  try {
    return fs.readFileSync(os.homedir() + '/.claude-token', 'utf8').trim();
  } catch { return null; }
}
const { authMiddleware } = require('./cdp-auth');
const { inferCareerStages, parseCareerStages } = require('../lib/career-stage');
const db = require('../db/database');

const router = express.Router();

// ─── Storage directory ────────────────────────────────────────────────────────
const RESUME_DIR = path.join(os.homedir(), 'data', 'resumes');
fs.mkdirSync(RESUME_DIR, { recursive: true });

// ─── DB Tables ────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS resume_parse_jobs (
    id          TEXT PRIMARY KEY,
    student_uid TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'processing',
    result      TEXT,
    error       TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS cdp_resumes (
    id            TEXT PRIMARY KEY,
    student_uid   TEXT NOT NULL,
    label         TEXT,
    original_name TEXT NOT NULL,
    file_path     TEXT NOT NULL,
    file_size     INTEGER,
    mime_type     TEXT,
    status        TEXT NOT NULL DEFAULT 'processing',
    parsed_data   TEXT,
    error         TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_cdp_resumes_student ON cdp_resumes(student_uid)`);

// ─── Multer ───────────────────────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!/\.(pdf|txt|doc|docx)$/i.test(file.originalname)) {
      return cb(new Error('Only PDF, Word, and text files are accepted.'));
    }
    cb(null, true);
  },
});

const CLAUDE_BIN = '/home/agent/.local/bin/claude';

// ─── Parse prompt ─────────────────────────────────────────────────────────────
const PARSE_PROMPT = `You are parsing a student resume for a STEM career platform. Extract key information and return ONLY a valid JSON object — no markdown, no explanation, just raw JSON.

Return exactly this structure (use null for missing fields, empty array [] for missing lists):
{
  "name": "First Last",
  "email": "email@example.com or null",
  "gpa": "3.XX or null",
  "school": "Most recent or primary university name or null",
  "major": "Field of study or null",
  "year": "one of: Freshman, Sophomore, Junior, Senior, Graduate, PhD, Community College, Other — infer from graduation year and degree level, or null",
  "career_stage": ["array of applicable stages — can include multiple: high_school|community_college|undergraduate|graduate|phd|postdoc|professional — e.g. grad student with full-time job = [\"graduate\",\"professional\"]; undergrad with internship still in school = [\"undergraduate\"]; working professional with no current enrollment = [\"professional\"]"],
  "gradYear": "4-digit expected graduation year or null",
  "skills": ["Python", "MATLAB", "etc — technical and professional skills only, extracted from Skills section and throughout resume"],
  "experience": [
    {
      "id": "8-char random hex like a1b2c3d4",
      "type": "work|research|education|leadership|volunteer|other",
      "title": "Job Title or Degree (e.g. B.S. Materials Science)",
      "org": "Organization or University name",
      "duration": "Month Year – Month Year (e.g. May 2023 – Aug 2023, or Aug 2024 – Present)",
      "startDate": "YYYY-MM (e.g. 2023-05)",
      "endDate": "YYYY-MM or null if current/ongoing",
      "description": "1-2 sentence summary of key responsibilities and achievements",
      "skills": ["specific tools/techniques used in this role"]
    }
  ]
}

Type guide:
- "work" = internship, job, industry employment
- "research" = research assistant, lab researcher, academic/computational research
- "education" = degree program (B.S., M.S., Ph.D., A.A.)
- "leadership" = club officer, co-founder, board member, nonprofit leadership
- "volunteer" = volunteer, community service
- "other" = anything else

IMPORTANT:
- Include BOTH work/research experience AND education entries in the experience array
- Sort experience by startDate descending (most recent first)
- Generate a unique 8-character hex id for each entry
- Use null endDate for current/ongoing positions
- For "Present" or ongoing roles, set endDate to null
- Extract month as 2-digit (01-12). If only year is given, use 01 for January

RESUME TEXT:
`;

// ─── Agentic merge prompt ──────────────────────────────────────────────────────
const MERGE_PROMPT_TEMPLATE = (existingJson, parsedJson) => `You are merging a student's career profile with data from a newly uploaded resume.

TASK: Produce a single merged profile that is more complete and accurate than either input alone.

RULES:
1. DEDUPLICATE experience — same position at same org with overlapping dates = ONE entry. Handle fuzzy matches:
   - Org abbreviations: "WPAFB" = "Wright-Patterson AFB", "INL" = "Idaho National Laboratory", "NIH" = "National Institutes of Health"
   - Parenthetical notes are the same org: "Idaho National Laboratory" = "Idaho National Laboratory (DOE)"
   - Same title + same org prefix + overlapping dates = same entry
   - Different wording for same role: keep the more complete/descriptive version, or combine descriptions
   - If genuinely ambiguous, keep both
2. SKILLS — union of all skills, case-insensitive dedup (prefer capitalized form e.g. "Python" not "python")
3. PROFILE FIELDS — prefer non-null, more complete values:
   - school, major, year, gradYear: update if new value is more complete
   - GPA: keep existing numeric gpa if set; adopt new value only if existing is null
   - career_stage: ALWAYS recompute as an array from the merged profile + experience. A person can have multiple stages simultaneously (e.g. grad student with a current job = ["graduate","professional"]). Valid values: high_school, community_college, undergraduate, graduate, phd, postdoc, professional
4. PRESERVE exactly from existing: interests, goals, targetTimeline, experienceLevel, savedPrograms, gapAnalyses
5. SORT experience by startDate descending (most recent first)
6. For merged experience entries, ensure each has a unique "id" (8-char hex)

Return ONLY a valid JSON object — NO markdown, NO explanation, NO code fences. Just raw JSON matching this exact schema:
{
  "profile": {
    "firstName": "...",
    "lastName": "...",
    "email": "...",
    "school": "...",
    "year": "...",
    "major": "...",
    "gradYear": "...",
    "career_stage": ["array e.g. [\"graduate\",\"professional\"] — recompute from all merged data"],
    "createdAt": "...",
    "updatedAt": "<ISO timestamp of now>"
  },
  "skills": [...],
  "experience": [...],
  "interests": [...],
  "goals": [...],
  "gpa": <number or null>,
  "targetTimeline": <string or null>,
  "experienceLevel": <string or null>,
  "savedPrograms": [...],
  "gapAnalyses": [...],
  "resumeUploaded": true
}

EXISTING STUDENT PROFILE:
${JSON.stringify(existingJson, null, 2)}

NEWLY PARSED RESUME DATA:
${JSON.stringify(parsedJson, null, 2)}
`;

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function extractTextFromPDF(buffer) {
  const { PDFParse } = require('pdf-parse');
  const parser = new PDFParse({ data: buffer });
  const result = await parser.getText();
  await parser.destroy();
  if (!result.text) throw new Error('No text extracted from PDF');
  return result.text;
}

function spawnClaude(prompt, timeoutMs = 90000) {
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

    const timer = setTimeout(() => { child.kill(); reject(new Error('Claude timed out')); }, timeoutMs);

    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`claude exited ${code}: ${stderr.slice(0, 300)}`));
      resolve(stdout);
    });

    child.on('error', err => { clearTimeout(timer); reject(err); });
  });
}

async function parseWithClaude(resumeText) {
  const stdout = await spawnClaude(PARSE_PROMPT + resumeText.slice(0, 8000));
  const jsonMatch = stdout.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in Claude response');
  return JSON.parse(jsonMatch[0]);
}

function sanitizeFilename(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/\.\.+/g, '_');
}

// ─── Completeness recompute (shared) ──────────────────────────────────────────
function recomputeCompleteness(sd) {
  let score = 0;
  if (sd.profile?.firstName) score += 10;
  if (sd.profile?.lastName) score += 5;
  if (sd.profile?.school) score += 10;
  if (sd.profile?.year) score += 10;
  if (sd.profile?.major) score += 10;
  if (sd.interests && sd.interests.length > 0) score += 15;
  if (sd.skills && sd.skills.length > 0) score += 10;
  if (sd.goals && sd.goals.length > 0) score += 10;
  if (sd.targetTimeline) score += 5;
  if (sd.gpa) score += 5;
  if (sd.resumeUploaded) score += 5;
  if (sd.experience && sd.experience.length > 0) score += 5;
  sd.profileCompleteness = Math.min(100, score);
  return sd;
}

// ─── Agentic merge — Claude reasons about what's new vs duplicate ──────────────
async function mergeWithClaude(existingProfile, parsed) {
  const prompt = MERGE_PROMPT_TEMPLATE(existingProfile, parsed);
  const stdout = await spawnClaude(prompt, 120000);
  const jsonMatch = stdout.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in Claude merge response');
  const merged = JSON.parse(jsonMatch[0]);
  // Always recompute completeness on the backend (don't trust Claude's number)
  recomputeCompleteness(merged);
  return merged;
}

// ─── Programmatic merge — fallback if agentic merge fails ─────────────────────
function mergeStudentDataFallback(sd, parsed) {
  if (parsed.skills && parsed.skills.length > 0) {
    const existingLower = new Map((sd.skills || []).map(s => [s.toLowerCase(), s]));
    for (const s of parsed.skills) {
      if (!existingLower.has(s.toLowerCase())) existingLower.set(s.toLowerCase(), s);
    }
    sd.skills = Array.from(existingLower.values());
  }
  if (parsed.gpa && !sd.gpa) {
    const gpaNum = parseFloat(parsed.gpa);
    if (!isNaN(gpaNum)) sd.gpa = gpaNum;
  }
  if (!sd.profile) sd.profile = {};
  if (parsed.school && !sd.profile.school) sd.profile.school = parsed.school;
  if (parsed.major && !sd.profile.major) sd.profile.major = parsed.major;
  if (parsed.year && !sd.profile.year) sd.profile.year = parsed.year;
  if (parsed.gradYear && !sd.profile.gradYear) sd.profile.gradYear = String(parsed.gradYear);
  if (parsed.experience && parsed.experience.length > 0) {
    const existing = sd.experience || [];
    const newEntries = parsed.experience.filter(e => !existing.some(ex =>
      ex.title?.toLowerCase() === e.title?.toLowerCase() &&
      ex.org?.toLowerCase().slice(0, 8) === e.org?.toLowerCase().slice(0, 8) &&
      ex.startDate === e.startDate
    ));
    sd.experience = [...existing, ...newEntries].sort((a, b) =>
      (b.startDate || '0000-00').localeCompare(a.startDate || '0000-00')
    );
  }
  sd.resumeUploaded = true;
  sd.profile.updatedAt = new Date().toISOString();
  return recomputeCompleteness(sd);
}

async function runParseJob(jobId, resumeId, studentUid, fileBuffer, mimeType, originalName) {
  try {
    let text = '';
    if (mimeType === 'application/pdf' || originalName.toLowerCase().endsWith('.pdf')) {
      text = await extractTextFromPDF(fileBuffer);
    } else {
      text = fileBuffer.toString('utf8');
    }

    if (!text.trim()) throw new Error('Could not extract text from file.');

    const parsed = await parseWithClaude(text);

    // Mark job complete (legacy table)
    db.prepare(`UPDATE resume_parse_jobs SET status='complete', result=?, updated_at=datetime('now') WHERE id=?`)
      .run(JSON.stringify(parsed), jobId);

    // Update cdp_resumes record if we have a resumeId
    if (resumeId) {
      const skillsCount = (parsed.skills || []).length;
      const expCount = (parsed.experience || []).length;
      db.prepare(`UPDATE cdp_resumes SET status='parsed', parsed_data=?, updated_at=datetime('now') WHERE id=?`)
        .run(JSON.stringify({ skills_count: skillsCount, experience_count: expCount, skills: parsed.skills || [], experience: parsed.experience || [] }), resumeId);
    }

    // Merge into student profile (agentic merge, falls back to programmatic)
    const student = db.prepare('SELECT * FROM cdp_students WHERE uid=?').get(studentUid);
    if (student) {
      try {
        const existingProfile = student.student_data_json ? JSON.parse(student.student_data_json) : {
          profile: { firstName: student.first_name || '', lastName: student.last_name || '', email: student.email || '', school: student.school || '', year: '', major: student.major || '', gradYear: '', createdAt: student.created_at, updatedAt: new Date().toISOString() },
          interests: [], skills: [], goals: [], targetTimeline: '', gpa: null, experienceLevel: '', profileCompleteness: 0, savedPrograms: [], gapAnalyses: [], resumeUploaded: false,
        };

        let merged;
        try {
          console.log(`[resume] Running agentic merge for ${studentUid}...`);
          merged = await mergeWithClaude(existingProfile, parsed);
          console.log(`[resume] Agentic merge complete — ${(merged.skills || []).length} skills, ${(merged.experience || []).length} exp entries`);
        } catch (mergeErr) {
          console.warn(`[resume] Agentic merge failed, using programmatic fallback: ${mergeErr.message}`);
          merged = mergeStudentDataFallback({ ...existingProfile }, parsed);
        }

        // Ensure resumeUploaded flag and timestamp
        merged.resumeUploaded = true;
        if (merged.profile) merged.profile.updatedAt = new Date().toISOString();

        const colUpdates = {};
        if (merged.profile?.school && !student.school) colUpdates.school = merged.profile.school;
        if (merged.profile?.major && !student.major) colUpdates.major = merged.profile.major;
        if (merged.profile?.gradYear && !student.graduation_year) colUpdates.graduation_year = parseInt(merged.profile.gradYear) || null;

        if (Object.keys(colUpdates).length > 0) {
          const sets = Object.keys(colUpdates).map(k => `${k} = ?`).join(', ');
          db.prepare(`UPDATE cdp_students SET ${sets}, updated_at=datetime('now') WHERE uid=?`)
            .run(...Object.values(colUpdates), studentUid);
        }

        // Compute and store career_stage from the merged profile + experience
        const agentStages = parseCareerStages(merged.profile?.career_stage);
        const computedStages = agentStages.length > 0
          ? agentStages
          : inferCareerStages(merged.profile || {}, merged.experience || []);

        db.prepare(`UPDATE cdp_students SET student_data_json=?, career_stage=?, updated_at=datetime('now') WHERE uid=?`)
          .run(JSON.stringify(merged), JSON.stringify(computedStages), studentUid);

        console.log(`[resume] Job ${jobId} saved for ${studentUid}: completeness=${merged.profileCompleteness}%, stages=${JSON.stringify(computedStages)}`);
      } catch (e) {
        console.error('[resume] Failed to merge student data:', e.message);
      }
    }
  } catch (err) {
    console.error('[resume] Job failed:', jobId, err.message);
    db.prepare(`UPDATE resume_parse_jobs SET status='error', error=?, updated_at=datetime('now') WHERE id=?`)
      .run(err.message, jobId);
    if (resumeId) {
      db.prepare(`UPDATE cdp_resumes SET status='error', error=?, updated_at=datetime('now') WHERE id=?`)
        .run(err.message, resumeId);
    }
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// POST /api/cdp/resume/upload — save file to disk, background parse
router.post('/resume/upload', authMiddleware, upload.single('resume'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

  const studentUid = req.student.uid;
  const resumeId = uuidv4();
  const jobId = uuidv4();
  const safeName = sanitizeFilename(req.file.originalname);
  const fileName = `${resumeId}_${safeName}`;
  const studentDir = path.join(RESUME_DIR, studentUid);
  const filePath = path.join(studentDir, fileName);

  fs.mkdirSync(studentDir, { recursive: true });
  fs.writeFileSync(filePath, req.file.buffer);

  const label = req.file.originalname.replace(/\.[^/.]+$/, '').replace(/[_-]/g, ' ');

  db.prepare(`INSERT INTO cdp_resumes (id, student_uid, label, original_name, file_path, file_size, mime_type, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'processing')`)
    .run(resumeId, studentUid, label, req.file.originalname, filePath, req.file.size, req.file.mimetype);

  db.prepare(`INSERT INTO resume_parse_jobs (id, student_uid, status) VALUES (?, ?, 'processing')`)
    .run(jobId, studentUid);

  res.json({ ok: true, resume_id: resumeId, job_id: jobId, status: 'processing' });

  const { buffer, mimetype, originalname } = req.file;
  setImmediate(() => {
    runParseJob(jobId, resumeId, studentUid, buffer, mimetype, originalname).catch(err => {
      console.error('[resume] Unhandled error:', err.message);
    });
  });
});

// POST /api/cdp/resume/parse — legacy (no file storage, backwards compat)
router.post('/resume/parse', authMiddleware, upload.single('resume'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

  const jobId = uuidv4();
  const studentUid = req.student.uid;

  db.prepare(`INSERT INTO resume_parse_jobs (id, student_uid, status) VALUES (?, ?, 'processing')`).run(jobId, studentUid);
  res.json({ ok: true, job_id: jobId, status: 'processing' });

  const { buffer, mimetype, originalname } = req.file;
  setImmediate(() => {
    runParseJob(jobId, null, studentUid, buffer, mimetype, originalname).catch(err => {
      console.error('[resume] Unhandled error:', err.message);
    });
  });
});

// GET /api/cdp/resumes — list all resumes for student
router.get('/resumes', authMiddleware, (req, res) => {
  const resumes = db.prepare(
    `SELECT id, label, original_name, file_size, mime_type, status, parsed_data, error, created_at
     FROM cdp_resumes WHERE student_uid=? ORDER BY created_at DESC`
  ).all(req.student.uid);

  const formatted = resumes.map(r => {
    let parsedSummary = null;
    if (r.parsed_data) {
      try {
        const pd = JSON.parse(r.parsed_data);
        parsedSummary = { skills_count: pd.skills_count || 0, experience_count: pd.experience_count || 0, skills: (pd.skills || []).slice(0, 5) };
      } catch {}
    }
    return {
      id: r.id,
      label: r.label || r.original_name.replace(/\.[^/.]+$/, ''),
      original_name: r.original_name,
      file_size: r.file_size,
      status: r.status,
      parsed_summary: parsedSummary,
      error: r.error,
      created_at: r.created_at,
    };
  });

  res.json({ ok: true, resumes: formatted });
});

// GET /api/cdp/resumes/:id/status
router.get('/resumes/:id/status', authMiddleware, (req, res) => {
  const resume = db.prepare(
    `SELECT id, status, parsed_data, error, updated_at FROM cdp_resumes WHERE id=? AND student_uid=?`
  ).get(req.params.id, req.student.uid);

  if (!resume) return res.status(404).json({ error: 'Resume not found' });

  let parsedSummary = null;
  if (resume.parsed_data) {
    try {
      const pd = JSON.parse(resume.parsed_data);
      parsedSummary = { skills_count: pd.skills_count || 0, experience_count: pd.experience_count || 0, skills: (pd.skills || []).slice(0, 5) };
    } catch {}
  }

  res.json({ ok: true, id: resume.id, status: resume.status, parsed_summary: parsedSummary, error: resume.error, updated_at: resume.updated_at });
});

// PATCH /api/cdp/resumes/:id — update label
router.patch('/resumes/:id', authMiddleware, (req, res) => {
  const { label } = req.body;
  if (!label || typeof label !== 'string') return res.status(400).json({ error: 'label required' });

  const resume = db.prepare(`SELECT id FROM cdp_resumes WHERE id=? AND student_uid=?`).get(req.params.id, req.student.uid);
  if (!resume) return res.status(404).json({ error: 'Resume not found' });

  db.prepare(`UPDATE cdp_resumes SET label=?, updated_at=datetime('now') WHERE id=?`).run(label.slice(0, 100), req.params.id);
  res.json({ ok: true });
});

// DELETE /api/cdp/resumes/:id
router.delete('/resumes/:id', authMiddleware, (req, res) => {
  const resume = db.prepare(`SELECT id, file_path FROM cdp_resumes WHERE id=? AND student_uid=?`).get(req.params.id, req.student.uid);
  if (!resume) return res.status(404).json({ error: 'Resume not found' });

  try { fs.unlinkSync(resume.file_path); } catch {}
  db.prepare(`DELETE FROM cdp_resumes WHERE id=?`).run(req.params.id);
  res.json({ ok: true });
});

// GET /api/cdp/resumes/:id/download — serve original file
router.get('/resumes/:id/download', authMiddleware, (req, res) => {
  const resume = db.prepare(
    `SELECT id, original_name, file_path, mime_type FROM cdp_resumes WHERE id=? AND student_uid=?`
  ).get(req.params.id, req.student.uid);

  if (!resume) return res.status(404).json({ error: 'Resume not found' });
  if (!fs.existsSync(resume.file_path)) return res.status(404).json({ error: 'File not found on server' });

  // Sanitize filename: strip control chars and quotes to prevent header injection
  const safeFilename = resume.original_name.replace(/[\x00-\x1f\x7f"\\]/g, '_');
  const encodedFilename = encodeURIComponent(safeFilename);
  res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"; filename*=UTF-8''${encodedFilename}`);
  res.setHeader('Content-Type', resume.mime_type || 'application/octet-stream');
  res.sendFile(resume.file_path);
});

// GET /api/cdp/resume/status/:jobId — legacy job status
router.get('/resume/status/:jobId', authMiddleware, (req, res) => {
  const job = db.prepare('SELECT * FROM resume_parse_jobs WHERE id=? AND student_uid=?')
    .get(req.params.jobId, req.student.uid);

  if (!job) return res.status(404).json({ error: 'Job not found' });

  const response = { job_id: job.id, status: job.status, created_at: job.created_at, updated_at: job.updated_at };
  if (job.status === 'complete' && job.result) response.parsed = JSON.parse(job.result);
  if (job.status === 'error') response.error = job.error;

  res.json(response);
});

module.exports = router;
