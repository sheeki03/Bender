'use strict';

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../db');

// ---------------------------------------------------------------------------
// Session auth middleware
// ---------------------------------------------------------------------------

function requireSession(req, res, next) {
  if (!req.session || !req.session.installId) {
    return res.status(401).json({ error: 'Session required' });
  }
  next();
}

function requireSessionMatch(req, res, next) {
  if (!req.session || !req.session.installId) {
    return res.status(401).json({ error: 'Session required' });
  }
  if (req.session.installId !== req.params.installId) {
    return res.status(403).json({ error: 'Session does not match install' });
  }
  next();
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * POST /admin/disconnect/:installId/:service — Disconnect a service.
 */
router.post('/disconnect/:installId/:service', requireSessionMatch, (req, res) => {
  const { installId, service } = req.params;

  if (service !== 'stremio' && service !== 'trakt') {
    return res.status(400).json({ error: 'Invalid service. Must be "stremio" or "trakt".' });
  }

  if (service === 'stremio') {
    db.updateInstall(installId, { stremioAuthKeyEnc: null });
  } else {
    db.updateInstall(installId, {
      traktAccessTokenEnc: null,
      traktRefreshTokenEnc: null,
      traktExpiresAt: null,
    });
  }

  // Invalidate cached recommendations — they were derived from the
  // disconnected source and must be rebuilt from remaining sources.
  db.clearCacheForInstall(installId);

  res.json({ ok: true });
});

/**
 * DELETE /admin/install/:installId — Delete install and all associated data.
 */
router.delete('/install/:installId', requireSessionMatch, (req, res) => {
  db.deleteInstall(req.params.installId);

  req.session = null;

  res.json({ ok: true });
});

/**
 * GET /admin/health — Public health check.
 */
router.get('/health', (req, res) => {
  res.json({ ok: true });
});

/**
 * POST /admin/recover — Recovery with manageToken.
 */
router.post('/recover', (req, res) => {
  const { installId, manageToken } = req.body;

  if (!installId || !manageToken) {
    return res.status(400).json({ error: 'installId and manageToken are required' });
  }

  const install = db.getInstall(installId);
  if (!install) {
    return res.status(404).json({ error: 'Install not found' });
  }

  const providedHash = crypto
    .createHash('sha256')
    .update(manageToken)
    .digest('hex');

  const storedHash = install.manageTokenHash;

  // Use timingSafeEqual to prevent timing attacks
  const a = Buffer.from(providedHash, 'hex');
  const b = Buffer.from(storedHash, 'hex');

  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(403).json({ error: 'Invalid token' });
  }

  req.session.installId = installId;

  res.json({ ok: true });
});

module.exports = router;
