'use strict';

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { getAuthUrl, exchangeCode } = require('../auth/trakt');
const { encrypt } = require('../utils/crypto');
const { config } = require('../config');
const db = require('../db');

// ---------------------------------------------------------------------------
// OAuth state store (in-memory with TTL)
//
// NOTE: pendingStates is in-memory. The same process must handle both
// /trakt/start (or /trakt/auth) and /trakt/callback. This is fine for
// single-instance SQLite deployment but won't work with multiple processes.
// ---------------------------------------------------------------------------

const pendingStates = new Map(); // state -> { installId, manageToken?, manageTokenHash?, flow, createdAt }

// Cleanup expired states every 5 minutes
setInterval(() => {
  const tenMinAgo = Date.now() - 600000;
  for (const [state, data] of pendingStates) {
    if (data.createdAt < tenMinAgo) pendingStates.delete(state);
  }
}, 300000).unref();

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * GET /trakt/start — Combined create + OAuth for new users.
 * No session required — nothing is persisted until OAuth succeeds in callback.
 */
router.get('/start', (req, res) => {
  if (!config.traktClientId || !config.traktClientSecret) {
    return res.status(503).json({ error: 'Trakt is not configured on this server' });
  }

  const installId = uuidv4();
  const manageToken = crypto.randomBytes(32).toString('hex');
  const manageTokenHash = crypto
    .createHash('sha256')
    .update(manageToken)
    .digest('hex');

  // Log before redirect so abandoned attempts appear in funnel.
  // The events table has no FK to installs, so this is safe with a not-yet-created installId.
  db.logEvent({ event: 'trakt_start', installId });

  const state = crypto.randomBytes(16).toString('hex');
  pendingStates.set(state, {
    installId,
    manageToken,
    manageTokenHash,
    flow: 'start',
    createdAt: Date.now(),
  });

  res.redirect(getAuthUrl(state));
});

/**
 * GET /trakt/auth — Initiate Trakt OAuth for existing installs (manage-page reconnect).
 * Requires session cookie with installId.
 */
router.get('/auth', (req, res) => {
  if (!config.traktClientId || !config.traktClientSecret) {
    return res.status(503).json({ error: 'Trakt is not configured on this server' });
  }
  if (!req.session || !req.session.installId) {
    return res.status(401).json({ error: 'Session required' });
  }

  const state = crypto.randomBytes(16).toString('hex');
  pendingStates.set(state, {
    installId: req.session.installId,
    flow: 'reconnect',
    createdAt: Date.now(),
  });

  res.redirect(getAuthUrl(state));
});

/**
 * GET /trakt/callback — Handle Trakt OAuth callback.
 * Branches on pending.flow to handle new users vs reconnects.
 */
router.get('/callback', async (req, res) => {
  try {
    const { code, state } = req.query;

    // Validate state
    const pending = pendingStates.get(state);
    if (!pending) {
      return res.status(400).json({ error: 'Invalid or expired OAuth state' });
    }

    // Check 10-minute TTL
    if (Date.now() - pending.createdAt > 600000) {
      pendingStates.delete(state);
      return res.status(400).json({ error: 'Invalid or expired OAuth state' });
    }

    // Delete immediately to prevent replay and memory leaks
    pendingStates.delete(state);

    const tokens = await exchangeCode(code);
    const expiresAt = tokens.created_at + tokens.expires_in;
    const traktAccessTokenEnc = encrypt(tokens.access_token);
    const traktRefreshTokenEnc = encrypt(tokens.refresh_token);

    const basePath = new URL(config.baseUrl).pathname.replace(/\/+$/, '');

    if (pending.flow === 'start') {
      // New user: create install atomically with Trakt tokens
      db.createInstall({
        id: pending.installId,
        manageTokenHash: pending.manageTokenHash,
        traktAccessTokenEnc,
        traktRefreshTokenEnc,
        traktExpiresAt: expiresAt,
      });

      req.session.installId = pending.installId;
      req.session.pendingManageToken = pending.manageToken;

      db.logEvent({ event: 'trakt_success', installId: pending.installId });

      res.redirect(`${basePath}/configure?installId=${pending.installId}&ready=1`);
    } else {
      // Reconnect (flow === 'reconnect' or missing flow for pre-update compat)
      const existing = db.getInstall(pending.installId);
      if (!existing) {
        return res.redirect(`${basePath}/configure?notfound=1`);
      }

      db.updateInstall(pending.installId, {
        traktAccessTokenEnc,
        traktRefreshTokenEnc,
        traktExpiresAt: expiresAt,
      });
      db.clearCacheForInstall(pending.installId);

      req.session.installId = pending.installId;

      db.logEvent({ event: 'trakt_success', installId: pending.installId });

      res.redirect(`${basePath}/configure?installId=${pending.installId}`);
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
