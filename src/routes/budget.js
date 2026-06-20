'use strict';

/**
 * Budget routes  (all require auth)
 *
 * GET    /budgets            – list all budgets
 * POST   /budgets            – create a budget
 * GET    /budgets/:budgetId  – get single budget
 * PUT    /budgets/:budgetId  – update budget
 * DELETE /budgets/:budgetId  – delete budget
 */

const { Router } = require('express');
const { body } = require('express-validator');
const { v4: uuidv4 } = require('uuid');
const db = require('../services/dynamodb');
const { requireAuth } = require('../middleware/auth');
const { validate } = require('../middleware/validate');

const router = Router();
router.use(requireAuth);

const VALID_PERIODS = ['weekly', 'monthly', 'yearly'];

// ─── List ─────────────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  try {
    const budgets = await db.getBudgets(req.user.userId);
    res.json(budgets);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Create ───────────────────────────────────────────────────────────────────

router.post(
  '/',
  [
    body('name').trim().notEmpty().isLength({ max: 100 }),
    body('amount').isFloat({ min: 0.01 }),
    body('category').trim().notEmpty().isLength({ max: 100 }),
    body('period').isIn(VALID_PERIODS),
  ],
  validate,
  async (req, res) => {
    const { name, amount, category, period } = req.body;
    const budgetId = uuidv4();
    try {
      const budget = await db.createBudget(req.user.userId, budgetId, {
        name,
        amount: parseFloat(amount),
        category,
        period,
      });
      res.status(201).json(budget);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// ─── Get single ───────────────────────────────────────────────────────────────

router.get('/:budgetId', async (req, res) => {
  try {
    const budget = await db.getBudget(req.user.userId, req.params.budgetId);
    if (!budget) return res.status(404).json({ error: 'Budget not found.' });
    res.json(budget);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Update ───────────────────────────────────────────────────────────────────

router.put(
  '/:budgetId',
  [
    body('name').optional().trim().notEmpty().isLength({ max: 100 }),
    body('amount').optional().isFloat({ min: 0.01 }),
    body('category').optional().trim().notEmpty().isLength({ max: 100 }),
    body('period').optional().isIn(VALID_PERIODS),
    body('spent').optional().isFloat({ min: 0 }),
  ],
  validate,
  async (req, res) => {
    const allowed = ['name', 'amount', 'category', 'period', 'spent'];
    const updates = Object.fromEntries(
      Object.entries(req.body).filter(([k]) => allowed.includes(k))
    );
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update.' });
    }
    if (updates.amount) updates.amount = parseFloat(updates.amount);
    if (updates.spent !== undefined) updates.spent = parseFloat(updates.spent);

    try {
      const budget = await db.getBudget(req.user.userId, req.params.budgetId);
      if (!budget) return res.status(404).json({ error: 'Budget not found.' });
      const updated = await db.updateBudget(req.user.userId, req.params.budgetId, updates);
      res.json(updated);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// ─── Delete ───────────────────────────────────────────────────────────────────

router.delete('/:budgetId', async (req, res) => {
  try {
    const budget = await db.getBudget(req.user.userId, req.params.budgetId);
    if (!budget) return res.status(404).json({ error: 'Budget not found.' });
    await db.deleteBudget(req.user.userId, req.params.budgetId);
    res.json({ message: 'Budget deleted.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
