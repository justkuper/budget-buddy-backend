'use strict';

/**
 * plaid.js
 *
 * Wraps Plaid API calls (sandbox mode by default).
 *
 * IMPORTANT: Plaid access tokens are NEVER returned to the frontend.
 *   They are encrypted and stored in DynamoDB by the route handler.
 *   Only account/transaction data (safe to expose) is forwarded.
 */

const { Configuration, PlaidApi, PlaidEnvironments, Products, CountryCode } = require('plaid');
const config = require('../config');

const plaidEnvMap = {
  sandbox: PlaidEnvironments.sandbox,
  development: PlaidEnvironments.development,
  production: PlaidEnvironments.production,
};

const plaidConfig = new Configuration({
  basePath: plaidEnvMap[config.plaid.env] || PlaidEnvironments.sandbox,
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': config.plaid.clientId,
      'PLAID-SECRET': config.plaid.secret,
    },
  },
});

const plaid = new PlaidApi(plaidConfig);

// ─── Link Token ───────────────────────────────────────────────────────────────

/**
 * Create a Plaid Link token.
 * The frontend passes this token to Plaid Link to open the bank login UI.
 *
 * @param {string} userId  – your internal Cognito userId (sub)
 * @param {string} [webhookUrl] – optional webhook for transaction updates
 */
async function createLinkToken(userId, webhookUrl) {
  const params = {
    user: { client_user_id: userId },
    client_name: 'SecureFinanceApp',
    products: [Products.Auth, Products.Transactions],
    country_codes: [CountryCode.Us],
    language: 'en',
  };
  if (webhookUrl) params.webhook = webhookUrl;

  const { data } = await plaid.linkTokenCreate(params);
  return data.link_token;
}

// ─── Token Exchange ───────────────────────────────────────────────────────────

/**
 * Exchange the short-lived public_token (from Plaid Link) for an access_token.
 * The access_token is sensitive and must be encrypted before storage.
 *
 * @returns {{ accessToken, itemId }}
 */
async function exchangePublicToken(publicToken) {
  const { data } = await plaid.itemPublicTokenExchange({ public_token: publicToken });
  return { accessToken: data.access_token, itemId: data.item_id };
}

// ─── Accounts ─────────────────────────────────────────────────────────────────

/**
 * Get accounts for an item.
 * Returns a safe subset — no raw access token exposed.
 *
 * @param {string} accessToken  – decrypted Plaid access token
 */
async function getAccounts(accessToken) {
  const { data } = await plaid.accountsGet({ access_token: accessToken });
  return data.accounts.map((a) => ({
    accountId: a.account_id,
    name: a.name,
    officialName: a.official_name,
    type: a.type,
    subtype: a.subtype,
    mask: a.mask,
    balances: {
      current: a.balances.current,
      available: a.balances.available,
      limit: a.balances.limit,
      isoCurrencyCode: a.balances.iso_currency_code,
    },
  }));
}

// ─── Transactions ─────────────────────────────────────────────────────────────

/**
 * Fetch recent transactions using the sync endpoint (handles adds/modifies/removes).
 * On first call pass cursor = null; store the returned nextCursor for incremental sync.
 *
 * @param {string} accessToken
 * @param {string|null} cursor
 * @returns {{ added, modified, removed, nextCursor, hasMore }}
 */
async function syncTransactions(accessToken, cursor = null) {
  const params = { access_token: accessToken };
  if (cursor) params.cursor = cursor;

  const { data } = await plaid.transactionsSync(params);
  return {
    added: data.added,
    modified: data.modified,
    removed: data.removed,
    nextCursor: data.next_cursor,
    hasMore: data.has_more,
  };
}

/**
 * Fetch transactions in a date range (simpler than sync, useful for initial load).
 *
 * @param {string} accessToken
 * @param {string} startDate  YYYY-MM-DD
 * @param {string} endDate    YYYY-MM-DD
 */
async function getTransactions(accessToken, startDate, endDate) {
  const { data } = await plaid.transactionsGet({
    access_token: accessToken,
    start_date: startDate,
    end_date: endDate,
    options: { count: 500, offset: 0 },
  });
  return data.transactions;
}

// ─── Item / Institution ────────────────────────────────────────────────────────

async function getInstitution(institutionId) {
  const { data } = await plaid.institutionsGetById({
    institution_id: institutionId,
    country_codes: [CountryCode.Us],
    options: { include_optional_metadata: true },
  });
  return {
    institutionId: data.institution.institution_id,
    name: data.institution.name,
    logo: data.institution.logo,
    primaryColor: data.institution.primary_color,
    url: data.institution.url,
  };
}

/**
 * Remove an item from Plaid (unlinks the bank account).
 * After this call the stored access token is invalid; delete it from DynamoDB.
 */
async function removeItem(accessToken) {
  await plaid.itemRemove({ access_token: accessToken });
}

module.exports = {
  createLinkToken,
  exchangePublicToken,
  getAccounts,
  syncTransactions,
  getTransactions,
  getInstitution,
  removeItem,
};
