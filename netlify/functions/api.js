'use strict';

/**
 * Netlify Functions entry point.
 *
 * Netlify routes /.netlify/functions/api/* to this file.
 * netlify.toml rewrites /api/* → /.netlify/functions/api/:splat
 * so your frontend calls /api/auth/login, /api/plaid/accounts, etc.
 */

const serverless = require('serverless-http');
const createApp = require('../../src/app');

const app = createApp();
const handler = serverless(app);

// Netlify Functions export format
module.exports.handler = async (event, context) => {
  // Strip the Netlify function prefix so Express sees clean paths
  // e.g. /.netlify/functions/api/auth/login → /auth/login
  if (event.path) {
    event.path = event.path.replace(/^\/.netlify\/functions\/api/, '') || '/';
  }
  if (event.rawPath) {
    event.rawPath = event.rawPath.replace(/^\/.netlify\/functions\/api/, '') || '/';
  }
  return handler(event, context);
};
