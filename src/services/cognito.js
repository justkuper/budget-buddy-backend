'use strict';

/**
 * cognito.js
 *
 * Wraps AWS Cognito Identity Provider operations.
 *
 * Auth flow summary:
 *   1.  register()      → sends email verification code
 *   2.  confirmEmail()  → verifies code, account becomes CONFIRMED
 *   3.  login()         → USER_PASSWORD_AUTH → returns tokens (if MFA not set)
 *                         or ChallengeName: MFA_SETUP / SOFTWARE_TOKEN_MFA
 *   4.  setupMfa()      → associate TOTP app, returns SecretCode + QR URI
 *   5.  verifyMfa()     → confirm TOTP code, enables MFA permanently
 *   6.  respondMfa()    → supply TOTP code to complete login challenge
 *   7.  refreshTokens() → exchange refresh token for new access/id tokens
 *   8.  logout()        → global sign-out (revokes all tokens)
 */

const {
  CognitoIdentityProviderClient,
  SignUpCommand,
  ConfirmSignUpCommand,
  InitiateAuthCommand,
  RespondToAuthChallengeCommand,
  AssociateSoftwareTokenCommand,
  VerifySoftwareTokenCommand,
  SetUserMFAPreferenceCommand,
  GlobalSignOutCommand,
  GetUserCommand,
  ForgotPasswordCommand,
  ConfirmForgotPasswordCommand,
} = require('@aws-sdk/client-cognito-identity-provider');
const config = require('../config');

const client = new CognitoIdentityProviderClient({ region: config.aws.region });
const CLIENT_ID = config.cognito.clientId;

// ─── Registration ─────────────────────────────────────────────────────────────

/**
 * Create a new Cognito user.
 * Cognito will send a verification email automatically.
 */
async function register(email, password) {
  await client.send(
    new SignUpCommand({
      ClientId: CLIENT_ID,
      Username: email,
      Password: password,
      UserAttributes: [{ Name: 'email', Value: email }],
    })
  );
}

/**
 * Confirm email with the 6-digit code Cognito sent.
 */
async function confirmEmail(email, code) {
  await client.send(
    new ConfirmSignUpCommand({
      ClientId: CLIENT_ID,
      Username: email,
      ConfirmationCode: code,
    })
  );
}

// ─── Login ────────────────────────────────────────────────────────────────────

/**
 * Initiate password authentication.
 *
 * Returns one of:
 *   { tokens }                         – auth complete (MFA not enabled)
 *   { challenge: 'MFA_SETUP', session } – user must set up TOTP
 *   { challenge: 'SOFTWARE_TOKEN_MFA', session } – user must supply TOTP code
 */
async function login(email, password) {
  const { AuthenticationResult, ChallengeName, Session } = await client.send(
    new InitiateAuthCommand({
      AuthFlow: 'USER_PASSWORD_AUTH',
      ClientId: CLIENT_ID,
      AuthParameters: { USERNAME: email, PASSWORD: password },
    })
  );

  if (AuthenticationResult) {
    return { tokens: _formatTokens(AuthenticationResult) };
  }

  return { challenge: ChallengeName, session: Session };
}

/**
 * Respond to SOFTWARE_TOKEN_MFA challenge with a TOTP code.
 */
async function respondMfa(email, totpCode, session) {
  const { AuthenticationResult } = await client.send(
    new RespondToAuthChallengeCommand({
      ChallengeName: 'SOFTWARE_TOKEN_MFA',
      ClientId: CLIENT_ID,
      Session: session,
      ChallengeResponses: {
        USERNAME: email,
        SOFTWARE_TOKEN_MFA_CODE: totpCode,
      },
    })
  );
  if (!AuthenticationResult) throw new Error('MFA response did not return tokens');
  return { tokens: _formatTokens(AuthenticationResult) };
}

// ─── MFA setup (called after first login) ────────────────────────────────────

/**
 * Step 1 of MFA setup: associate a TOTP app.
 * Requires a valid access token (user must be logged in, MFA not yet set).
 *
 * Returns { secretCode, qrUri } where qrUri can be rendered as a QR code.
 */
async function setupMfa(accessToken, email) {
  const { SecretCode, Session } = await client.send(
    new AssociateSoftwareTokenCommand({ AccessToken: accessToken })
  );
  const issuer = encodeURIComponent('SecureFinanceApp');
  const account = encodeURIComponent(email);
  const qrUri = `otpauth://totp/${issuer}:${account}?secret=${SecretCode}&issuer=${issuer}`;
  return { secretCode: SecretCode, qrUri, session: Session };
}

/**
 * Step 2 of MFA setup: verify the TOTP code and enable MFA.
 * After this call all subsequent logins require a TOTP code.
 */
async function verifyMfa(accessToken, totpCode, session) {
  await client.send(
    new VerifySoftwareTokenCommand({
      AccessToken: accessToken,
      UserCode: totpCode,
      Session: session,
    })
  );
  // Mark TOTP as the preferred (and required) MFA method
  await client.send(
    new SetUserMFAPreferenceCommand({
      AccessToken: accessToken,
      SoftwareTokenMfaSettings: { Enabled: true, PreferredMfa: true },
    })
  );
}

// ─── Token management ─────────────────────────────────────────────────────────

async function refreshTokens(refreshToken) {
  const { AuthenticationResult } = await client.send(
    new InitiateAuthCommand({
      AuthFlow: 'REFRESH_TOKEN_AUTH',
      ClientId: CLIENT_ID,
      AuthParameters: { REFRESH_TOKEN: refreshToken },
    })
  );
  return { tokens: _formatTokens(AuthenticationResult) };
}

async function logout(accessToken) {
  await client.send(new GlobalSignOutCommand({ AccessToken: accessToken }));
}

// ─── User info ────────────────────────────────────────────────────────────────

/**
 * Get Cognito user attributes from an access token (verify token is valid).
 * Returns { sub, email }.
 */
async function getUser(accessToken) {
  const { Username, UserAttributes } = await client.send(
    new GetUserCommand({ AccessToken: accessToken })
  );
  const attr = Object.fromEntries(UserAttributes.map(({ Name, Value }) => [Name, Value]));
  return { sub: attr.sub, email: attr.email, username: Username };
}

// ─── Password reset ───────────────────────────────────────────────────────────

async function forgotPassword(email) {
  await client.send(new ForgotPasswordCommand({ ClientId: CLIENT_ID, Username: email }));
}

async function confirmForgotPassword(email, code, newPassword) {
  await client.send(
    new ConfirmForgotPasswordCommand({
      ClientId: CLIENT_ID,
      Username: email,
      ConfirmationCode: code,
      Password: newPassword,
    })
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _formatTokens(result) {
  return {
    accessToken: result.AccessToken,
    idToken: result.IdToken,
    refreshToken: result.RefreshToken,
    expiresIn: result.ExpiresIn,
    tokenType: result.TokenType,
  };
}

module.exports = {
  register,
  confirmEmail,
  login,
  respondMfa,
  setupMfa,
  verifyMfa,
  refreshTokens,
  logout,
  getUser,
  forgotPassword,
  confirmForgotPassword,
};
