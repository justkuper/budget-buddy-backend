'use strict';

/**
 * auth.js  – Express middleware
 *
 * Verifies the Cognito-issued JWT (Bearer token in Authorization header).
 * Uses the Cognito JWKS endpoint — no Cognito Admin API call needed.
 *
 * On success: sets req.user = { userId, email, accessToken }
 * On failure: returns 401
 */

const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');
const config = require('../config');

const jwks = jwksClient({
  jwksUri: `${config.cognito.issuerUrl}/.well-known/jwks.json`,
  cache: true,
  cacheMaxAge: 60 * 60 * 1000, // 1 hour
  rateLimit: true,
});

function getSigningKey(header, callback) {
  jwks.getSigningKey(header.kid, (err, key) => {
    if (err) return callback(err);
    callback(null, key.getPublicKey());
  });
}

function verifyToken(token) {
  return new Promise((resolve, reject) => {
    jwt.verify(
      token,
      getSigningKey,
      {
        issuer: config.cognito.issuerUrl,
        algorithms: ['RS256'],
      },
      (err, decoded) => {
        if (err) reject(err);
        else resolve(decoded);
      }
    );
  });
}

/**
 * requireAuth middleware
 * Attach to any route that needs a logged-in user.
 */
async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or malformed Authorization header' });
  }
  const token = authHeader.slice(7);

  // Try custom JWT first (social login users)
  const secret = process.env.ENCRYPTION_FALLBACK_KEY;
  if (secret) {
    try {
      const decoded = jwt.verify(token, secret);
      if (decoded.provider) {
        req.user = { userId: decoded.sub, email: decoded.email, accessToken: token };
        return next();
      }
    } catch (_) {
      // Not a custom JWT — fall through to Cognito verification
    }
  }

  // Cognito JWT verification
  try {
    const decoded = await verifyToken(token);
    req.user = {
      userId: decoded.sub,
      email: decoded.email || decoded.username,
      accessToken: token,
    };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token', detail: err.message });
  }
}

module.exports = { requireAuth };
