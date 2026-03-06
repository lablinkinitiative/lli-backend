'use strict';

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3001;

// Trust nginx reverse proxy (required for express-rate-limit behind nginx)
app.set('trust proxy', 1);

// Security headers
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

// Rate limiting — auth endpoints: 20 req/15min per IP
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

// Rate limiting — general API: 200 req/15min per IP
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

app.use('/api/cdp/auth/register', authLimiter);
app.use('/api/cdp/auth/login', authLimiter);
app.use('/api/', apiLimiter);

// Middleware
app.use(cors({
  origin: [
    'https://lablinkinitiative.org',
    'https://cdp.lablinkinitiative.org',
    'https://intern.lablinkinitiative.org',
    'https://newsletter.lablinkinitiative.org',
    'https://app.lablinkinitiative.org',
    // Allow localhost for dev
    /^http:\/\/localhost(:\d+)?$/
  ],
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// CDP Routes
app.use('/api/cdp', require('./routes/cdp-auth'));
app.use('/api/cdp', require('./routes/cdp-oauth'));
app.use('/api/cdp', require('./routes/cdp-students'));
app.use('/api/cdp', require('./routes/cdp-resume'));
app.use('/api/cdp', require('./routes/cdp-gap-analysis'));
app.use('/api/cdp', require('./routes/cdp-pathways'));

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'LabLink Initiative CDP API',
    version: '2.0.0',
    timestamp: new Date().toISOString(),
    endpoints: {
      auth: {
        register: 'POST /api/cdp/auth/register',
        login:    'POST /api/cdp/auth/login',
        me:       'GET  /api/cdp/auth/me'
      },
      students: {
        profile:       'GET|PUT /api/cdp/students/me/profile',
        savedPrograms: 'GET|POST|DELETE /api/cdp/students/me/saved-programs',
        gapAnalyses:   'GET|POST /api/cdp/students/me/gap-analyses'
      },
      programs: {
        list:        'GET /api/cdp/programs',
        list_params: '?q=&type=&field=&sector=&career_stage=&benefits=&has_stipend=&remote=&keywords=&page=&limit=',
        detail:      'GET /api/cdp/programs/:slug',
        tags_summary:'GET /api/cdp/programs/tags/summary',
        intern:      'GET /api/cdp/intern/opportunities',
        cdp_export:  'GET /api/cdp/export/cdp-format',
      }
    }
  });
});

// Root info
app.get('/', (req, res) => {
  res.json({
    name: 'LabLink Initiative CDP API',
    version: '2.0.0',
    docs: 'https://github.com/lablinkinitiative/lli-backend',
    health: '/health'
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Startup: warn loudly if JWT secret is using insecure dev fallback
if (!process.env.CDP_JWT_SECRET) {
  console.warn('[lablink-api] WARNING: CDP_JWT_SECRET not set — using insecure dev fallback. Set this in systemd service env!');
}

// Startup cleanup: reset any analyses/resumes stuck in 'processing' state from previous run
// This happens when the service restarts while a Claude subprocess was running
try {
  const db = require('./db/database');
  const stuckAnalyses = db.prepare(
    "UPDATE cdp_gap_analyses_v2 SET status='error', error='Service restarted while processing — please re-run', updated_at=datetime('now') WHERE status='processing'"
  ).run().changes;
  const stuckResumes = db.prepare(
    "UPDATE cdp_resumes SET status='error', error='Service restarted while processing — please re-upload', updated_at=datetime('now') WHERE status='processing'"
  ).run().changes;
  if (stuckAnalyses > 0) console.log(`[lablink-api] Reset ${stuckAnalyses} stuck gap analyses`);
  if (stuckResumes > 0) console.log(`[lablink-api] Reset ${stuckResumes} stuck resume parse jobs`);
} catch (e) {
  console.warn('[lablink-api] Startup cleanup failed:', e.message);
}

// Error handler
app.use((err, req, res, next) => {
  console.error('[ERROR]', err.stack || err.message);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`[lablink-api] Listening on port ${PORT}`);
  console.log(`[lablink-api] Health: http://localhost:${PORT}/health`);
});
