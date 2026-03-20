'use strict';

const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const path = require('path');
const db = require('../db');
const { config } = require('../config');
const { encrypt } = require('../utils/crypto');
const { login } = require('../auth/stremio');

// ---------------------------------------------------------------------------
// Rate limiting helper (in-memory, per IP)
// ---------------------------------------------------------------------------

const rateLimits = new Map(); // key -> { count, resetAt }

// Evict expired rate-limit entries every 5 minutes to prevent unbounded growth
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimits) {
    if (entry.resetAt < now) rateLimits.delete(key);
  }
}, 300000).unref();

function checkRateLimit(key, maxPerMin) {
  const now = Date.now();
  const entry = rateLimits.get(key);
  if (!entry || entry.resetAt < now) {
    rateLimits.set(key, { count: 1, resetAt: now + 60000 });
    return true;
  }
  if (entry.count >= maxPerMin) return false;
  entry.count++;
  return true;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * GET /configure — Serve the static HTML config page.
 */
router.get('/configure', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'configure.html'));
});

/**
 * GET /api/config — Public. Returns server feature flags for the configure page.
 */
router.get('/api/config', (req, res) => {
  res.json({
    traktConfigured: !!(config.traktClientId && config.traktClientSecret),
  });
});

/**
 * POST /api/install/init — Create a new empty install (legacy, kept for backward compat).
 */
router.post('/api/install/init', (req, res) => {
  const installId = uuidv4();
  const manageToken = crypto.randomBytes(32).toString('hex');
  const manageTokenHash = crypto
    .createHash('sha256')
    .update(manageToken)
    .digest('hex');

  db.createInstall({ id: installId, manageTokenHash });

  req.session.installId = installId;

  res.json({ installId, manageToken });
});

/**
 * POST /api/install/stremio — Connect Stremio credentials.
 *
 * Supports two modes:
 *   1. Existing install (session required): updates the install with Stremio auth.
 *   2. New install (body.createInstall === true, no session needed): authenticates
 *      with Stremio FIRST, then creates the install atomically. No orphan rows on
 *      auth failure.
 */
router.post('/api/install/stremio', async (req, res) => {
  try {
    const { email, password, createInstall: shouldCreate } = req.body;

    // Rate limit: 5 attempts per minute per IP
    if (!checkRateLimit('login:' + req.ip, 5)) {
      return res.status(429).json({ error: 'Too many login attempts. Try again later.' });
    }

    if (shouldCreate) {
      // --- New install flow: auth first, then create ---
      const { authKey } = await login(email, password);

      const installId = uuidv4();
      const manageToken = crypto.randomBytes(32).toString('hex');
      const manageTokenHash = crypto
        .createHash('sha256')
        .update(manageToken)
        .digest('hex');

      db.createInstall({
        id: installId,
        manageTokenHash,
        stremioAuthKeyEnc: encrypt(authKey),
      });

      req.session.installId = installId;
      req.session.pendingManageToken = manageToken;

      db.logEvent({ event: 'stremio_connect', installId });

      return res.json({ ok: true, installId });
    }

    // --- Existing install flow: session required ---
    const installId = req.body.installId;
    if (!req.session || req.session.installId !== installId) {
      return res.status(401).json({ error: 'Session required' });
    }

    const { authKey } = await login(email, password);

    db.updateInstall(installId, { stremioAuthKeyEnc: encrypt(authKey) });
    db.clearCacheForInstall(installId);

    db.logEvent({ event: 'stremio_connect', installId });

    res.json({ ok: true });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

/**
 * GET /api/install/pending-token — One-time retrieval of the manage token from session.
 * Returns the token and deletes it from the session. Returns null if not present.
 */
router.get('/api/install/pending-token', (req, res) => {
  if (!req.session || !req.session.installId) {
    return res.status(401).json({ error: 'Session required' });
  }

  res.set('Cache-Control', 'no-store');

  const token = req.session.pendingManageToken || null;
  // Delete from session — one-time retrieval
  req.session.pendingManageToken = null;

  res.json({ manageToken: token });
});

/**
 * POST /api/events — Client-only analytics events.
 * Public endpoint, rate-limited. Only whitelisted event names accepted.
 */
const CLIENT_EVENTS = new Set(['page_visit', 'deep_link_click']);

router.post('/api/events', (req, res) => {
  if (!checkRateLimit('events:' + req.ip, 10)) {
    return res.status(429).json({ error: 'Rate limit exceeded' });
  }

  const { event, installId, meta } = req.body;

  if (!event || !CLIENT_EVENTS.has(event)) {
    return res.status(400).json({ error: 'Invalid or missing event name' });
  }

  const metaStr = meta ? JSON.stringify(meta).slice(0, 1024) : null;
  db.logEvent({ event, installId: installId || null, meta: metaStr });

  res.json({ ok: true });
});

/**
 * GET /api/install/:id/status — Check install status.
 * Requires session cookie.
 */
router.get('/api/install/:id/status', (req, res) => {
  // Check existence before session so deleted installs always return 404,
  // not 401 (which the UI would present as a recoverable expired session).
  const install = db.getInstall(req.params.id);
  if (!install) {
    return res.status(404).json({ error: 'Install not found' });
  }

  if (!req.session || req.session.installId !== req.params.id) {
    return res.status(401).json({ error: 'Session required' });
  }

  res.json({
    hasStremio: !!install.stremioAuthKeyEnc,
    hasTrakt: !!install.traktAccessTokenEnc,
    traktExpiry: install.traktExpiresAt || null,
    traktConfigured: !!(config.traktClientId && config.traktClientSecret),
  });
});

module.exports = router;
