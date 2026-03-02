'use strict';

const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3001;

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
app.use('/api/cdp', require('./routes/cdp-students'));

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
        list:   'GET /api/cdp/programs',
        detail: 'GET /api/cdp/programs/:slug'
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

// Error handler
app.use((err, req, res, next) => {
  console.error('[ERROR]', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`[lablink-api] Listening on port ${PORT}`);
  console.log(`[lablink-api] Health: http://localhost:${PORT}/health`);
});
