'use strict';

/**
 * AWS Lambda entry point.
 *
 * Deployed via Serverless Framework (serverless.yml).
 * API Gateway → Lambda → serverless-http → Express app
 */

const serverless = require('serverless-http');
const createApp = require('../src/app');

const app = createApp();

// serverless-http wraps the Express app for Lambda's event/context format
module.exports.handler = serverless(app, {
  // Preserve the request path prefix if you mount at a base path
  // basePath: '/api',
});
