'use strict';

/**
 * Auth routes
 *
 * POST /auth/register            – create account (sends email verification)
 * POST /auth/confirm             – confirm email with code
 * POST /auth/login               – password login → tokens or MFA challenge
 * POST /auth/login/mfa           – complete TOTP challenge → tokens
 * POST /auth/mfa/setup           – get TOTP secret + QR URI  (🔒 auth required)
 * POST /auth/mfa/verify          – confirm TOTP code, enable MFA (🔒 auth required)
 * POST /auth/refresh             – refresh access token
 * POST /auth/logout              – global sign-out (🔒 auth required)
 * POST /auth/forgot-password     – send reset code
 * POST /auth/reset-password      – apply new password with reset code
 */

const { Router } = require('express');
const { body } = require('express-validator');
const cognito = require('../services/cognito');
const db = require('../services/dynamodb');
const { requireAuth } = require('../middleware/auth');
const { validate } = require('../middleware/validate');

const router = Router();

// ─── Register ─────────────────────────────────────────────────────────────────

router.post(
  '/register',
  [
    body('email').isEmail().normalizeEmail(),
    body('password')
      .isLength({ min: 8 })
      .matches(/[A-Z]/).withMessage('Must contain an uppercase letter')
      .matches(/[0-9]/).withMessage('Must contain a number')
      .matches(/[^A-Za-z0-9]/).withMessage('Must contain a special character'),
  ],
  validate,
  async (req, res) => {
    const { email, password } = req.body;
    try {
      await cognito.register(email, password);
      res.status(201).json({ message: 'Account created. Check your email for a verification code.' });
    } catch (err) {
      if (err.name === 'UsernameExistsException') {
        return res.status(409).json({ error: 'An account with this email already exists.' });
      }
      res.status(400).json({ error: err.message });
    }
  }
);

// ─── Confirm Email ────────────────────────────────────────────────────────────

router.post(
  '/confirm',
  [body('email').isEmail().normalizeEmail(), body('code').notEmpty()],
  validate,
  async (req, res) => {
    const { email, code } = req.body;
    try {
      await cognito.confirmEmail(email, code);
      res.json({ message: 'Email confirmed. You may now log in.' });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }
);

// ─── Login ────────────────────────────────────────────────────────────────────

router.post(
  '/login',
  [body('email').isEmail().normalizeEmail(), body('password').notEmpty()],
  validate,
  async (req, res) => {
    const { email, password } = req.body;
    try {
      const result = await cognito.login(email, password);

      if (result.tokens) {
        // Ensure user record exists in DynamoDB (first login)
        const userId = _subFromIdToken(result.tokens.idToken);
        const existing = await db.getUser(userId);
        if (!existing) await db.createUser(userId, { email });
        return res.json(result.tokens);
      }

      // MFA challenge
      return res.status(202).json({ challenge: result.challenge, session: result.session });
    } catch (err) {
      if (err.name === 'NotAuthorizedException') {
        return res.status(401).json({ error: 'Incorrect email or password.' });
      }
      if (err.name === 'UserNotConfirmedException') {
        return res.status(403).json({ error: 'Email not confirmed. Check your inbox.' });
      }
      res.status(400).json({ error: err.message });
    }
  }
);

// ─── Complete MFA login ───────────────────────────────────────────────────────

router.post(
  '/login/mfa',
  [body('email').isEmail().normalizeEmail(), body('totpCode').notEmpty(), body('session').notEmpty()],
  validate,
  async (req, res) => {
    const { email, totpCode, session } = req.body;
    try {
      const { tokens } = await cognito.respondMfa(email, totpCode, session);
      // Ensure user record exists
      const userId = _subFromIdToken(tokens.idToken);
      const existing = await db.getUser(userId);
      if (!existing) await db.createUser(userId, { email });
      res.json(tokens);
    } catch (err) {
      if (err.name === 'CodeMismatchException') {
        return res.status(401).json({ error: 'Invalid TOTP code.' });
      }
      res.status(400).json({ error: err.message });
    }
  }
);

// ─── MFA Setup ────────────────────────────────────────────────────────────────

router.post('/mfa/setup', requireAuth, async (req, res) => {
  try {
    const { secretCode, qrUri, session } = await cognito.setupMfa(req.user.accessToken, req.user.email);
    res.json({ secretCode, qrUri, session });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── MFA Verify (enable) ──────────────────────────────────────────────────────

router.post(
  '/mfa/verify',
  requireAuth,
  [body('totpCode').notEmpty(), body('session').notEmpty()],
  validate,
  async (req, res) => {
    const { totpCode, session } = req.body;
    try {
      await cognito.verifyMfa(req.user.accessToken, totpCode, session);
      res.json({ message: 'TOTP MFA enabled successfully.' });
    } catch (err) {
      if (err.name === 'EnableSoftwareTokenMFAException') {
        return res.status(400).json({ error: 'Invalid TOTP code — please try again.' });
      }
      res.status(400).json({ error: err.message });
    }
  }
);

// ─── Refresh Token ────────────────────────────────────────────────────────────

router.post(
  '/refresh',
  [body('refreshToken').notEmpty()],
  validate,
  async (req, res) => {
    try {
      const { tokens } = await cognito.refreshTokens(req.body.refreshToken);
      res.json(tokens);
    } catch (err) {
      res.status(401).json({ error: err.message });
    }
  }
);

// ─── Logout ───────────────────────────────────────────────────────────────────

router.post('/logout', requireAuth, async (req, res) => {
  try {
    await cognito.logout(req.user.accessToken);
    res.json({ message: 'Signed out from all devices.' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── Forgot / Reset Password ──────────────────────────────────────────────────

router.post(
  '/forgot-password',
  [body('email').isEmail().normalizeEmail()],
  validate,
  async (req, res) => {
    try {
      await cognito.forgotPassword(req.body.email);
      // Always return 200 to avoid email enumeration
      res.json({ message: 'If that email exists, a reset code has been sent.' });
    } catch (_) {
      res.json({ message: 'If that email exists, a reset code has been sent.' });
    }
  }
);

router.post(
  '/reset-password',
  [body('email').isEmail().normalizeEmail(), body('code').notEmpty(), body('newPassword').isLength({ min: 8 })],
  validate,
  async (req, res) => {
    const { email, code, newPassword } = req.body;
    try {
      await cognito.confirmForgotPassword(email, code, newPassword);
      res.json({ message: 'Password reset successful.' });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  }
);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _subFromIdToken(idToken) {
  // Decode (not verify — already verified by Cognito) to extract sub
  const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString());
  return payload.sub;
}

module.exports = router;
