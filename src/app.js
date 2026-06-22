'use strict';

/**
 * app.js  – Express application factory
 *
 * Exported as a function so it can be mounted by:
 *   - src/server.js     (local development)
 *   - lambda/handler.js (AWS Lambda via serverless-http)
 *   - netlify/functions/api.js (Netlify Functions via serverless-http)
 */

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const config = require('./config');

const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const plaidRoutes = require('./routes/plaid');
const budgetRoutes = require('./routes/budget');
const twofaRoutes = require('./routes/twofa');

function createApp() {
  const app = express();

  // ─── Security headers ──────────────────────────────────────────────────────
  app.use(helmet());

  // ─── CORS ──────────────────────────────────────────────────────────────────
  app.use(
    cors({
      origin: (origin, callback) => {
        // Allow server-to-server calls (no origin) in dev
        if (!origin) return callback(null, true);
        const allowed = config.app.allowedOrigins;
        if (allowed.includes('*') || allowed.includes(origin)) {
          return callback(null, true);
        }
        callback(new Error(`CORS: origin ${origin} not allowed`));
      },
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
      credentials: true,
    })
  );

  // ─── Body parser ───────────────────────────────────────────────────────────
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false }));

  // ─── Rate limiting ─────────────────────────────────────────────────────────
  // Strict limit on auth endpoints to prevent brute-force
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,   // 15 minutes
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' },
  });

  const generalLimiter = rateLimit({
    windowMs: 60 * 1000,         // 1 minute
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
  });

  app.use('/auth', authLimiter);
  app.use(generalLimiter);

  // ─── Routes ────────────────────────────────────────────────────────────────
  app.use('/auth', authRoutes);
  app.use('/users', userRoutes);
  app.use('/plaid', plaidRoutes);
  app.use('/budgets', budgetRoutes);
  app.use('/api', twofaRoutes);

  // ─── Health check ──────────────────────────────────────────────────────────
  app.get('/health', (_, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

  // ─── 404 ───────────────────────────────────────────────────────────────────
  app.use((req, res) => res.status(404).json({ error: 'Not found' }));

  // ─── Global error handler ──────────────────────────────────────────────────
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: config.app.isDev ? err.message : 'Internal server error' });
  });

  return app;
}

module.exports = createApp;
