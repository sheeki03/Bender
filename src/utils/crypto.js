'use strict';

const crypto = require('crypto');
const { config } = require('../config');

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Encrypt plaintext using AES-256-GCM.
 * @param {string} plaintext
 * @returns {string} "hexIV:hexCiphertext:hexTag"
 */
function encrypt(plaintext) {
  const key = Buffer.from(config.encryptionKey, 'hex');
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return [
    iv.toString('hex'),
    encrypted.toString('hex'),
    tag.toString('hex'),
  ].join(':');
}

/**
 * Decrypt an "hexIV:hexCiphertext:hexTag" string back to plaintext.
 * @param {string} encrypted
 * @returns {string} plaintext
 */
function decrypt(encrypted) {
  if (!encrypted || typeof encrypted !== 'string') {
    throw new Error('decrypt: invalid input — expected non-empty string');
  }
  const parts = encrypted.split(':');
  if (parts.length !== 3) {
    throw new Error('decrypt: malformed ciphertext — expected format iv:ciphertext:tag');
  }
  const [ivHex, ciphertextHex, tagHex] = parts;
  const key = Buffer.from(config.encryptionKey, 'hex');
  const iv = Buffer.from(ivHex, 'hex');
  const ciphertext = Buffer.from(ciphertextHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return decrypted.toString('utf8');
}

module.exports = { encrypt, decrypt };
