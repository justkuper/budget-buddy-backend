'use strict';

/**
 * Plaid routes  (all require auth)
 *
 * POST /plaid/link-token          – create a Plaid Link token for the frontend
 * POST /plaid/exchange            – exchange public_token → store encrypted access_token
 * GET  /plaid/items               – list linked institutions
 * GET  /plaid/accounts            – list all accounts across all items
 * GET  /plaid/transactions        – get/sync transactions (stored in DynamoDB)
 * DELETE /plaid/items/:itemId     – unlink bank, remove from DynamoDB + Plaid
 */

const { Router } = require('express');
const { body, query } = require('express-validator');
const { v4: uuidv4 } = require('uuid');
const plaidService = require('../services/plaid');
const db = require('../services/dynamodb');
const { encrypt, decrypt } = require('../services/encryption');
const { requireAuth } = require('../middleware/auth');
const { validate } = require('../middleware/validate');

const router = Router();
router.use(requireAuth);

// ─── Create Link Token ────────────────────────────────────────────────────────

router.post('/link-token', async (req, res) => {
  try {
    const linkToken = await plaidService.createLinkToken(req.user.userId);
    res.json({ linkToken });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Exchange Public Token ─────────────────────────────────────────────────────

router.post(
  '/exchange',
  [body('publicToken').notEmpty()],
  validate,
  async (req, res) => {
    const { publicToken } = req.body;
    try {
      // 1. Exchange with Plaid
      const { accessToken, itemId } = await plaidService.exchangePublicToken(publicToken);

      // 2. Encrypt access token before storing
      const encryptedAccessToken = await encrypt(accessToken);

      // 3. Fetch account list to store with the item record
      const accounts = await plaidService.getAccounts(accessToken);

      // 4. Try to get institution metadata via Plaid item endpoint
      let institutionId = null, institutionName = null;
      try {
        const { Configuration, PlaidApi, PlaidEnvironments } = require('plaid');
        const config = require('../config');
        const plaidEnvMap = { sandbox: PlaidEnvironments.sandbox, development: PlaidEnvironments.development, production: PlaidEnvironments.production };
        const _plaid = new PlaidApi(new Configuration({
          basePath: plaidEnvMap[config.plaid.env] || PlaidEnvironments.sandbox,
          baseOptions: { headers: { 'PLAID-CLIENT-ID': config.plaid.clientId, 'PLAID-SECRET': config.plaid.secret } },
        }));
        const { data: itemData } = await _plaid.itemGet({ access_token: accessToken });
        institutionId = itemData.item.institution_id;
        if (institutionId) {
          const inst = await plaidService.getInstitution(institutionId);
          institutionName = inst.name;
        }
      } catch (_) { /* non-critical — item saved without institution name */ }

      // 5. Save to DynamoDB
      await db.savePlaidItem(req.user.userId, itemId, {
        encryptedAccessToken,
        institutionId,
        institutionName,
        accounts,
      });

      // 6. Mark user as plaid-linked
      await db.updateUser(req.user.userId, { plaidLinked: true });

      res.status(201).json({ itemId, accounts, institutionName });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// ─── List Items (linked institutions) ─────────────────────────────────────────

router.get('/items', async (req, res) => {
  try {
    const items = await db.getPlaidItems(req.user.userId);
    // Never return encryptedAccessToken to client
    const safe = items.map(({ encryptedAccessToken: _omit, ...rest }) => rest);
    res.json(safe);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Get Accounts ─────────────────────────────────────────────────────────────

router.get('/accounts', async (req, res) => {
  try {
    const items = await db.getPlaidItems(req.user.userId);
    if (items.length === 0) return res.json([]);

    const allAccounts = await Promise.all(
      items.map(async (item) => {
        const accessToken = await decrypt(item.encryptedAccessToken);
        const accounts = await plaidService.getAccounts(accessToken);
        return accounts.map((a) => ({ ...a, institutionName: item.institutionName, itemId: item.itemId }));
      })
    );
    res.json(allAccounts.flat());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Get / Sync Transactions ──────────────────────────────────────────────────

router.get(
  '/transactions',
  [query('limit').optional().isInt({ min: 1, max: 200 }).toInt()],
  validate,
  async (req, res) => {
    const limit = req.query.limit || 50;
    try {
      // Pull from DynamoDB (already synced)
      const { items, nextKey } = await db.getTransactions(req.user.userId, { limit });
      res.json({ transactions: items, nextKey });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

/**
 * Trigger a fresh sync from Plaid into DynamoDB.
 * Call this after initial link and from a webhook handler.
 */
router.post('/transactions/sync', async (req, res) => {
  try {
    const items = await db.getPlaidItems(req.user.userId);
    if (items.length === 0) return res.json({ synced: 0 });

    let totalAdded = 0;
    for (const item of items) {
      const accessToken = await decrypt(item.encryptedAccessToken);
      const { added } = await plaidService.syncTransactions(accessToken);
      if (added.length > 0) {
        await db.saveTransactions(req.user.userId, added);
        totalAdded += added.length;
      }
    }
    res.json({ synced: totalAdded });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Unlink Bank Account ──────────────────────────────────────────────────────

router.delete('/items/:itemId', async (req, res) => {
  const { itemId } = req.params;
  try {
    const item = await db.getPlaidItem(req.user.userId, itemId);
    if (!item) return res.status(404).json({ error: 'Item not found.' });

    // Remove from Plaid first
    const accessToken = await decrypt(item.encryptedAccessToken);
    await plaidService.removeItem(accessToken);

    // Remove from DynamoDB
    await db.deletePlaidItem(req.user.userId, itemId);

    // Check if user still has other items
    const remaining = await db.getPlaidItems(req.user.userId);
    if (remaining.length === 0) {
      await db.updateUser(req.user.userId, { plaidLinked: false });
    }

    res.json({ message: 'Bank account unlinked.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
