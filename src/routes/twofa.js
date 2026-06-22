'use strict';

/**
 * Two-Factor Auth routes
 *
 * POST /api/send-2fa-code    – generate & email/SMS a 6-digit code
 * POST /api/verify-2fa-code  – verify the signed token + code
 */

const { Router } = require('express');
const { createHmac, randomInt } = require('crypto');

const router = Router();

const SECRET = () => process.env.TWO_FA_SECRET || process.env.ENCRYPTION_FALLBACK_KEY || 'dev-secret';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function signToken(code, contact, method) {
  const expiry = Date.now() + 10 * 60 * 1000; // 10 minutes
  const payload = JSON.stringify({ code, contact, method, expiry });
  const sig = createHmac('sha256', SECRET()).update(payload).digest('hex');
  return Buffer.from(JSON.stringify({ payload, sig })).toString('base64');
}

function verifyToken(token, submittedCode) {
  try {
    const { payload, sig } = JSON.parse(Buffer.from(token, 'base64').toString());
    const expectedSig = createHmac('sha256', SECRET()).update(payload).digest('hex');
    if (sig !== expectedSig) return { valid: false, reason: 'Invalid token' };
    const { code, expiry } = JSON.parse(payload);
    if (Date.now() > expiry) return { valid: false, reason: 'Code has expired. Please request a new one.' };
    if (code !== submittedCode) return { valid: false, reason: 'Incorrect code. Please try again.' };
    return { valid: true };
  } catch {
    return { valid: false, reason: 'Invalid token' };
  }
}

async function sendEmail(to, code) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY is not configured.');

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Budget Buddy <onboarding@resend.dev>',
      to: [to],
      subject: `Your Budget Buddy verification code: ${code}`,
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px">
          <h2 style="color:#6C63FF">Budget Buddy</h2>
          <p>Your verification code is:</p>
          <div style="font-size:2.5rem;font-weight:900;letter-spacing:12px;color:#6C63FF;margin:24px 0">${code}</div>
          <p style="color:#888;font-size:0.9rem">This code expires in 10 minutes. If you didn't request this, you can safely ignore this email.</p>
        </div>
      `,
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `Resend error ${res.status}`);
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

router.post('/send-2fa-code', async (req, res) => {
  const { method, contact } = req.body || {};
  if (!method || !contact) {
    return res.status(400).json({ error: 'method and contact are required' });
  }

  try {
    const code = String(randomInt(100000, 999999));

    if (method === 'email') {
      await sendEmail(contact, code);
    } else {
      return res.status(400).json({ error: 'method must be email' });
    }

    const token = signToken(code, contact, method);
    res.json({ success: true, token });
  } catch (err) {
    console.error('send-2fa-code error:', err);
    res.status(500).json({ error: err.message || 'Failed to send code' });
  }
});

router.post('/verify-2fa-code', (req, res) => {
  const { token, code } = req.body || {};
  if (!token || !code) {
    return res.status(400).json({ error: 'token and code are required' });
  }
  const result = verifyToken(token, code);
  return res.status(result.valid ? 200 : 400).json(result.valid ? { success: true } : { error: result.reason });
});

module.exports = router;
