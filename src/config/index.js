'use strict';

require('dotenv').config();

function required(name) {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

function optional(name, fallback = '') {
  return process.env[name] || fallback;
}

module.exports = {
  aws: {
    region: optional('AWS_REGION', 'us-east-1'),
  },

  cognito: {
    userPoolId: required('COGNITO_USER_POOL_ID'),
    clientId: required('COGNITO_CLIENT_ID'),
    // JWKS issuer URL derived automatically
    get issuerUrl() {
      return `https://cognito-idp.${module.exports.aws.region}.amazonaws.com/${module.exports.cognito.userPoolId}`;
    },
  },

  dynamo: {
    usersTable: optional('DYNAMODB_USERS_TABLE', 'finance-users'),
    plaidTable: optional('DYNAMODB_PLAID_TABLE', 'finance-plaid-items'),
    budgetsTable: optional('DYNAMODB_BUDGETS_TABLE', 'finance-budgets'),
    transactionsTable: optional('DYNAMODB_TRANSACTIONS_TABLE', 'finance-transactions'),
  },

  encryption: {
    kmsKeyId: optional('KMS_KEY_ID'),           // preferred
    fallbackKey: optional('ENCRYPTION_FALLBACK_KEY'), // used when no KMS key
  },

  plaid: {
    clientId: required('PLAID_CLIENT_ID'),
    secret: required('PLAID_SECRET'),
    env: optional('PLAID_ENV', 'sandbox'),
  },

  app: {
    port: parseInt(optional('PORT', '3001'), 10),
    nodeEnv: optional('NODE_ENV', 'development'),
    allowedOrigins: optional('ALLOWED_ORIGINS', 'http://localhost:3000').split(','),
    isDev: optional('NODE_ENV', 'development') !== 'production',
  },
};
