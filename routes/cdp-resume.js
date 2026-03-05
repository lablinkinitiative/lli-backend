'use strict';

const express = require('express');
const multer = require('multer');
const { spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const os = require('os');

// Read auth token for spawning Claude subprocess
function getClaudeToken() {
  // Prefer existing env var (set when service has it)
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return process.env.CLAUDE_CODE_OAUTH_TOKEN;
  // Fall back to token file
  try {
    return fs.readFileSync(os.homedir() + '/.claude-token', 'utf8').trim();
  } catch { return null; }
}
const { authMiddleware } = require('./cdp-auth');
const db = require('../db/database');

const router = express.Router();

// Ensure resume_parse_jobs table exists
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

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = /\.(pdf|txt|doc|docx)$/i;
    if (!allowed.test(file.originalname)) {
      return cb(new Error('Only PDF, Word, and text files are accepted.'));
    }
    cb(null, true);
  },
});

const CLAUDE_BIN = '/home/agent/.local/bin/claude';

const PARSE_PROMPT = `You are parsing a student resume for a STEM career platform. Extract key information and return ONLY a valid JSON object — no markdown, no explanation, just raw JSON.

Return exactly this structure (use null for missing fields, empty array [] for missing lists):
{
  "name": "First Last",
  "email": "email@example.com or null",
  "gpa": "3.XX or null",
  "school": "Most recent or primary university name or null",
  "major": "Field of study or null",
  "year": "one of: Freshman, Sophomore, Junior, Senior, Graduate, PhD, Community College, Other — infer from graduation year and degree level, or null",
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
    // Ensure auth token is available to the subprocess
    const token = getClaudeToken();
    if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token;

    const child = spawn(CLAUDE_BIN, [
      '--print', '--dangerously-skip-permissions', '--output-format', 'text', prompt
    ], { env, stdio: ['pipe', 'pipe', 'pipe'] });

    child.stdin.end(); // don't block on stdin

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);

    const timer = setTimeout(() => { child.kill(); reject(new Error('Claude parse timed out')); }, timeoutMs);

    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`claude exited ${code}: ${stderr.slice(0, 300)}`));
      resolve(stdout);
    });

    child.on('error', err => { clearTimeout(timer); reject(err); });
  });
}

async function parseWithClaude(resumeText) {
  const fullPrompt = PARSE_PROMPT + resumeText.slice(0, 8000);
  const stdout = await spawnClaude(fullPrompt);
  const jsonMatch = stdout.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in Claude response. stdout: ' + stdout.slice(0, 200));
  return JSON.parse(jsonMatch[0]);
}

async function runParseJob(jobId, studentUid, fileBuffer, mimeType, originalName) {
  try {
    let text = '';
    const nameLower = originalName.toLowerCase();

    if (mimeType === 'application/pdf' || nameLower.endsWith('.pdf')) {
      text = await extractTextFromPDF(fileBuffer);
    } else {
      text = fileBuffer.toString('utf8');
    }

    if (!text.trim()) {
      throw new Error('Could not extract text from file. Try uploading a .txt version.');
    }

    const parsed = await parseWithClaude(text);

    // Mark job complete
    db.prepare(`
      UPDATE resume_parse_jobs SET status = 'complete', result = ?, updated_at = datetime('now') WHERE id = ?
    `).run(JSON.stringify(parsed), jobId);

    // Merge parsed data into student profile
    const student = db.prepare('SELECT * FROM cdp_students WHERE uid = ?').get(studentUid);
    if (student) {
      try {
        // Initialize student_data_json if missing (account exists but no onboarding yet)
        const sd = student.student_data_json ? JSON.parse(student.student_data_json) : {
          profile: { firstName: student.first_name || '', lastName: student.last_name || '', email: student.email || '', school: student.school || '', year: '', major: student.major || '', gradYear: '', createdAt: student.created_at, updatedAt: new Date().toISOString() },
          interests: [], skills: [], goals: [], targetTimeline: '', gpa: null, experienceLevel: '', profileCompleteness: 0, savedPrograms: [], gapAnalyses: [], resumeUploaded: false,
        };

        if (parsed.skills && parsed.skills.length > 0) {
          const existing = sd.skills || [];
          sd.skills = Array.from(new Set([...existing, ...parsed.skills]));
        }
        if (parsed.gpa) {
          const gpaNum = parseFloat(parsed.gpa);
          if (!isNaN(gpaNum)) sd.gpa = gpaNum;
        }
        if (!sd.profile) sd.profile = {};
        if (parsed.school && !sd.profile.school) sd.profile.school = parsed.school;
        if (parsed.major && !sd.profile.major) sd.profile.major = parsed.major;
        if (parsed.year && !sd.profile.year) sd.profile.year = parsed.year;
        if (parsed.gradYear && !sd.profile.gradYear) sd.profile.gradYear = String(parsed.gradYear);

        // Merge experience timeline — replace if resume has richer data
        if (parsed.experience && parsed.experience.length > 0) {
          const existing = sd.experience || [];
          // Deduplicate by title+org combo; parsed entries take precedence
          const existingKeys = new Set(existing.map(e => `${e.title}||${e.org}`));
          const newEntries = parsed.experience.filter(e => !existingKeys.has(`${e.title}||${e.org}`));
          // Merge: keep existing manual entries, add new parsed ones
          sd.experience = [...existing, ...newEntries].sort((a, b) => {
            const da = a.startDate || '0000-00';
            const db2 = b.startDate || '0000-00';
            return db2.localeCompare(da); // descending
          });
        }

        sd.resumeUploaded = true;
        sd.resumeFileName = originalName;
        sd.resumeParsedAt = new Date().toISOString();
        sd.profile.updatedAt = new Date().toISOString();

        let score = 0;
        if (sd.profile.firstName) score += 10;
        if (sd.profile.lastName) score += 5;
        if (sd.profile.school) score += 10;
        if (sd.profile.year) score += 10;
        if (sd.profile.major) score += 10;
        if (sd.interests && sd.interests.length > 0) score += 15;
        if (sd.skills && sd.skills.length > 0) score += 10;
        if (sd.goals && sd.goals.length > 0) score += 10;
        if (sd.targetTimeline) score += 5;
        if (sd.gpa) score += 5;
        if (sd.resumeUploaded) score += 5;
        if (sd.experience && sd.experience.length > 0) score += 5;
        sd.profileCompleteness = Math.min(100, score);

        // Update both student_data_json AND top-level DB columns (used by full-data API)
        const colUpdates = {};
        if (parsed.school && !student.school) colUpdates.school = parsed.school;
        if (parsed.major && !student.major) colUpdates.major = parsed.major;
        if (parsed.gradYear && !student.graduation_year) colUpdates.graduation_year = parseInt(parsed.gradYear) || null;

        if (Object.keys(colUpdates).length > 0) {
          const sets = Object.keys(colUpdates).map(k => `${k} = ?`).join(', ');
          db.prepare(`UPDATE cdp_students SET ${sets}, updated_at = datetime('now') WHERE uid = ?`)
            .run(...Object.values(colUpdates), studentUid);
        }

        db.prepare(`UPDATE cdp_students SET student_data_json = ?, updated_at = datetime('now') WHERE uid = ?`)
          .run(JSON.stringify(sd), studentUid);

        console.log(`[resume-parse] Job ${jobId} complete — profile updated for ${studentUid}`);
      } catch (e) {
        console.error('[resume-parse] Failed to merge student data:', e.message);
      }
    }
  } catch (err) {
    console.error('[resume-parse] Job failed:', jobId, err.message);
    db.prepare(`
      UPDATE resume_parse_jobs SET status = 'error', error = ?, updated_at = datetime('now') WHERE id = ?
    `).run(err.message, jobId);
  }
}

// POST /api/cdp/resume/parse
// Starts background parse — returns immediately with job_id
router.post('/resume/parse', authMiddleware, upload.single('resume'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded.' });
  }

  const jobId = uuidv4();
  const studentUid = req.student.uid;

  db.prepare(`INSERT INTO resume_parse_jobs (id, student_uid, status) VALUES (?, ?, 'processing')`).run(jobId, studentUid);

  res.json({ ok: true, job_id: jobId, status: 'processing' });

  const { buffer, mimetype, originalname } = req.file;
  setImmediate(() => {
    runParseJob(jobId, studentUid, buffer, mimetype, originalname).catch(err => {
      console.error('[resume-parse] Unhandled background error:', err.message);
    });
  });
});

// GET /api/cdp/resume/status/:jobId
router.get('/resume/status/:jobId', authMiddleware, (req, res) => {
  const job = db.prepare('SELECT * FROM resume_parse_jobs WHERE id = ? AND student_uid = ?')
    .get(req.params.jobId, req.student.uid);

  if (!job) return res.status(404).json({ error: 'Job not found' });

  const response = {
    job_id: job.id,
    status: job.status,
    created_at: job.created_at,
    updated_at: job.updated_at,
  };

  if (job.status === 'complete' && job.result) {
    response.parsed = JSON.parse(job.result);
  }
  if (job.status === 'error') {
    response.error = job.error;
  }

  res.json(response);
});

module.exports = router;
