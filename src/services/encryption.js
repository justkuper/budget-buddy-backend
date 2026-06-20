'use strict';

/**
 * encryption.js
 *
 * Encrypts/decrypts sensitive data (Plaid access tokens, etc.) using:
 *   1. AWS KMS — generates a per-field data key (recommended, requires KMS_KEY_ID)
 *   2. AES-256-GCM fallback — uses ENCRYPTION_FALLBACK_KEY when KMS is not configured
 *
 * Encrypted blobs are stored as JSON strings:
 *   { v: 1, mode: "kms"|"aes", encryptedKey?: "<hex>", iv: "<hex>", tag: "<hex>", data: "<hex>" }
 */

const crypto = require('crypto');
const { KMSClient, GenerateDataKeyCommand, DecryptCommand } = require('@aws-sdk/client-kms');
const config = require('../config');

const kmsClient = new KMSClient({ region: config.aws.region });

// ─── AES-256-GCM helpers ────────────────────────────────────────────────────

function aesEncrypt(plaintext, keyHex) {
  const key = Buffer.from(keyHex, 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv: iv.toString('hex'), tag: tag.toString('hex'), data: encrypted.toString('hex') };
}

function aesDecrypt(iv, tag, dataHex, keyHex) {
  const key = Buffer.from(keyHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(tag, 'hex'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataHex, 'hex')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Encrypt a plaintext string.
 * @param {string} plaintext
 * @returns {Promise<string>} Serialized JSON blob safe to store in DynamoDB
 */
async function encrypt(plaintext) {
  if (config.encryption.kmsKeyId) {
    // KMS path: generate a fresh data key for each value
    const { CiphertextBlob, Plaintext } = await kmsClient.send(
      new GenerateDataKeyCommand({
        KeyId: config.encryption.kmsKeyId,
        KeySpec: 'AES_256',
      })
    );
    const dataKeyPlain = Buffer.from(Plaintext).toString('hex');
    const { iv, tag, data } = aesEncrypt(plaintext, dataKeyPlain);
    return JSON.stringify({
      v: 1,
      mode: 'kms',
      encryptedKey: Buffer.from(CiphertextBlob).toString('hex'),
      iv,
      tag,
      data,
    });
  }

  // AES fallback path
  if (!config.encryption.fallbackKey || config.encryption.fallbackKey.length < 64) {
    throw new Error('Set KMS_KEY_ID or provide a 64-char hex ENCRYPTION_FALLBACK_KEY');
  }
  const { iv, tag, data } = aesEncrypt(plaintext, config.encryption.fallbackKey);
  return JSON.stringify({ v: 1, mode: 'aes', iv, tag, data });
}

/**
 * Decrypt a blob produced by encrypt().
 * @param {string} blob
 * @returns {Promise<string>} Original plaintext
 */
async function decrypt(blob) {
  const { v, mode, encryptedKey, iv, tag, data } = JSON.parse(blob);
  if (v !== 1) throw new Error(`Unknown encryption version: ${v}`);

  if (mode === 'kms') {
    const { Plaintext } = await kmsClient.send(
      new DecryptCommand({
        CiphertextBlob: Buffer.from(encryptedKey, 'hex'),
        KeyId: config.encryption.kmsKeyId,
      })
    );
    const dataKeyPlain = Buffer.from(Plaintext).toString('hex');
    return aesDecrypt(iv, tag, data, dataKeyPlain);
  }

  if (mode === 'aes') {
    return aesDecrypt(iv, tag, data, config.encryption.fallbackKey);
  }

  throw new Error(`Unknown encryption mode: ${mode}`);
}

module.exports = { encrypt, decrypt };
