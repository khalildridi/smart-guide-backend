const path = require('path');
const express = require('express');
const cors = require('cors');
const { randomUUID } = require('crypto');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });
const supabaseRoutes = require('./routes/supabase');
const crawlerRoutes = require('./routes/crawler');
const { createRateLimiter } = require('./middleware/rateLimit');

const app = express();
const configuredOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const defaultDevOrigins = [
  'http://localhost:8080',
  'http://127.0.0.1:8080',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
];
const allowedOrigins = configuredOrigins.length > 0 ? configuredOrigins : defaultDevOrigins;
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000);
const RATE_LIMIT_MAX_REQUESTS = Number(process.env.RATE_LIMIT_MAX_REQUESTS || 180);
const RATE_LIMIT_WRITE_WINDOW_MS = Number(process.env.RATE_LIMIT_WRITE_WINDOW_MS || 60_000);
const RATE_LIMIT_WRITE_MAX_REQUESTS = Number(process.env.RATE_LIMIT_WRITE_MAX_REQUESTS || 50);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
  })
);
app.use(express.json());
app.use((req, res, next) => {
  const requestId = req.headers['x-request-id'] || randomUUID();
  req.requestId = String(requestId);
  res.setHeader('x-request-id', req.requestId);
  const startedAt = Date.now();
  res.on('finish', () => {
    const durationMs = Date.now() - startedAt;
    console.log(
      `[${new Date().toISOString()}] ${req.method} ${req.originalUrl} ${res.statusCode} ${durationMs}ms request_id=${req.requestId}`
    );
  });
  next();
});

const apiLimiter = createRateLimiter({
  name: 'api',
  windowMs: RATE_LIMIT_WINDOW_MS,
  maxRequests: RATE_LIMIT_MAX_REQUESTS,
});

const writeLimiter = createRateLimiter({
  name: 'api-write',
  windowMs: RATE_LIMIT_WRITE_WINDOW_MS,
  maxRequests: RATE_LIMIT_WRITE_MAX_REQUESTS,
  skip(req) {
    return req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS';
  },
});

app.use('/api', apiLimiter);
app.use('/api/supabase/db', writeLimiter);

app.use('/api/supabase', supabaseRoutes);
app.use('/api/crawler', crawlerRoutes);

app.get('/api/health', (req, res) =>
  res.json({
    status: 'ok',
    service: 'backend-api',
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    requestId: req.requestId,
  })
);
app.get('/api/supabase/health', (req, res) => res.json({ status: 'ok' }));

app.use((err, req, res, next) => {
  const requestId = req.requestId || randomUUID();
  const message = err?.message || 'Internal server error';
  const status = message === 'Not allowed by CORS' ? 403 : 500;
  console.error('Unhandled error', { requestId, message, stack: err?.stack });
  res.status(status).json({
    error: status === 403 ? 'Not allowed by CORS' : 'Internal server error',
    requestId,
  });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
