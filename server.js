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
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// Routes
app.use('/api/labs',         require('./routes/labs'));
app.use('/api/equipment',    require('./routes/equipment'));
app.use('/api/bookings',     require('./routes/bookings'));
app.use('/api/waitlist',     require('./routes/waitlist'));
app.use('/api/labs',         require('./routes/experiments'));   // /api/labs/:slug/experiments
app.use('/api/reagents',     require('./routes/reagents'));
app.use('/api/calibrations', require('./routes/calibrations'));

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'LabLink Initiative Backend API',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    endpoints: {
      labs:         '/api/labs',
      equipment:    '/api/equipment',
      bookings:     '/api/bookings',
      waitlist:     '/api/waitlist',
      experiments:  '/api/labs/:slug/experiments',
      reagents:     '/api/reagents',
      calibrations: '/api/calibrations'
    }
  });
});

// Root info
app.get('/', (req, res) => {
  res.json({
    name: 'LabLink Initiative Backend API',
    version: '1.0.0',
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
