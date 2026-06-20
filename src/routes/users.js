'use strict';

/**
 * User profile routes  (all require auth)
 *
 * GET  /users/me        – get profile
 * PUT  /users/me        – update profile (display name, etc.)
 */

const { Router } = require('express');
const { body } = require('express-validator');
const db = require('../services/dynamodb');
const { requireAuth } = require('../middleware/auth');
const { validate } = require('../middleware/validate');

const router = Router();

router.use(requireAuth);

router.get('/me', async (req, res) => {
  try {
    const user = await db.getUser(req.user.userId);
    if (!user) return res.status(404).json({ error: 'User record not found.' });
    // Strip internal fields before responding
    const { userId, email, createdAt, updatedAt, plaidLinked } = user;
    res.json({ userId, email, createdAt, updatedAt, plaidLinked });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put(
  '/me',
  [body('displayName').optional().trim().isLength({ max: 100 })],
  validate,
  async (req, res) => {
    const allowed = ['displayName']; // whitelist updatable fields
    const updates = Object.fromEntries(
      Object.entries(req.body).filter(([k]) => allowed.includes(k))
    );
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No updatable fields provided.' });
    }
    try {
      const updated = await db.updateUser(req.user.userId, updates);
      res.json(updated);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

module.exports = router;
