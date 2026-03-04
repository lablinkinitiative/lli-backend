'use strict';

const express = require('express');
const multer = require('multer');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { authMiddleware } = require('./cdp-auth');

const router = express.Router();
const execFileAsync = promisify(execFile);

// Memory storage — resume text only, file not persisted
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
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
  "school": "University name or null",
  "major": "Field of study or null",
  "year": "one of: Freshman, Sophomore, Junior, Senior, Graduate, PhD, Community College, Other — infer from context, or null",
  "gradYear": "4-digit year like 2026 or null",
  "skills": ["Python", "MATLAB", "etc — technical and professional skills only"],
  "experience": [{"title": "Job Title", "org": "Organization", "duration": "Date range"}]
}

For "year", infer from graduation year, degree level, or explicit mentions. Skills should map to technical tools, programming languages, lab techniques, and professional competencies.

RESUME TEXT:
`;

async function extractTextFromPDF(buffer) {
  try {
    const pdfParse = require('pdf-parse');
    const data = await pdfParse(buffer);
    return data.text || '';
  } catch (err) {
    throw new Error('Could not extract text from PDF. Try uploading a .txt version instead.');
  }
}

async function parseWithClaude(resumeText) {
  const fullPrompt = PARSE_PROMPT + resumeText.slice(0, 8000); // cap at ~8K chars

  const env = { ...process.env };
  delete env.CLAUDECODE; // required for subprocess invocation

  const { stdout } = await execFileAsync(
    CLAUDE_BIN,
    ['--print', fullPrompt],
    { env, timeout: 90000, maxBuffer: 512 * 1024 }
  );

  // Extract JSON from response (Claude sometimes wraps it in markdown)
  const jsonMatch = stdout.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON found in Claude response');
  return JSON.parse(jsonMatch[0]);
}

// POST /api/cdp/resume/parse
// Accepts: multipart/form-data with file field "resume"
// Returns: parsed profile data as JSON
router.post('/resume/parse', authMiddleware, upload.single('resume'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded.' });
  }

  try {
    let text = '';
    const mime = req.file.mimetype;
    const name = req.file.originalname.toLowerCase();

    if (mime === 'application/pdf' || name.endsWith('.pdf')) {
      text = await extractTextFromPDF(req.file.buffer);
    } else {
      // text/plain, .txt, .doc, .docx — try reading as utf8
      text = req.file.buffer.toString('utf8');
    }

    if (!text.trim()) {
      return res.status(422).json({ error: 'Could not extract text from file. Please try a different format.' });
    }

    const parsed = await parseWithClaude(text);

    return res.json({
      ok: true,
      parsed,
      chars: text.length,
    });
  } catch (err) {
    console.error('[resume-parse] Error:', err.message);
    return res.status(500).json({ error: err.message || 'Failed to parse resume.' });
  }
});

module.exports = router;
