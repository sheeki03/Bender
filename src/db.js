'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { config } = require('./config');

let db;

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

const migrations = [
  {
    version: 1,
    up: `
      CREATE TABLE installs (
        id TEXT PRIMARY KEY,
        manage_token_hash TEXT NOT NULL,
        stremio_auth_key_enc TEXT,
        trakt_access_token_enc TEXT,
        trakt_refresh_token_enc TEXT,
        trakt_expires_at INTEGER,
        created_at INTEGER DEFAULT (unixepoch()),
        updated_at INTEGER DEFAULT (unixepoch())
      );

      CREATE TABLE recommendation_cache (
        install_id TEXT,
        type TEXT,
        ranked_json TEXT,
        computed_at INTEGER,
        library_freshness TEXT,
        PRIMARY KEY (install_id, type),
        FOREIGN KEY (install_id) REFERENCES installs(id) ON DELETE CASCADE
      );
    `,
  },
  {
    version: 2,
    up: `
      CREATE TABLE library_freshness (
        install_id TEXT PRIMARY KEY,
        stremio_max_mtime TEXT,
        trakt_movies_last_watched_at TEXT,
        trakt_shows_last_watched_at TEXT,
        checked_at INTEGER,
        FOREIGN KEY (install_id) REFERENCES installs(id) ON DELETE CASCADE
      );
    `,
  },
  {
    version: 3,
    up: `
      DROP TABLE IF EXISTS library_freshness;
      CREATE TABLE library_freshness (
        install_id TEXT,
        type TEXT,
        stremio_max_mtime TEXT,
        trakt_movies_last_watched_at TEXT,
        trakt_shows_last_watched_at TEXT,
        checked_at INTEGER,
        PRIMARY KEY (install_id, type),
        FOREIGN KEY (install_id) REFERENCES installs(id) ON DELETE CASCADE
      );
    `,
  },
  {
    version: 4,
    up: `
      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event TEXT NOT NULL,
        install_id TEXT,
        meta TEXT,
        created_at INTEGER DEFAULT (unixepoch())
      );
      CREATE INDEX idx_events_event ON events(event);
      CREATE INDEX idx_events_install_id ON events(install_id);
    `,
  },
  {
    version: 5,
    up: `
      ALTER TABLE recommendation_cache ADD COLUMN build_depth INTEGER;
      ALTER TABLE recommendation_cache ADD COLUMN build_budget INTEGER;
      ALTER TABLE recommendation_cache ADD COLUMN build_ok INTEGER DEFAULT 1;
    `,
  },
];

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

function initDb() {
  const dbPath = config.dbPath;
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Ensure migrations tracking table exists.
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER DEFAULT (unixepoch())
    );
  `);

  const applied = new Set(
    db.prepare('SELECT version FROM migrations').all().map(r => r.version),
  );

  for (const m of migrations) {
    if (applied.has(m.version)) continue;
    db.transaction(() => {
      db.exec(m.up);
      db.prepare('INSERT INTO migrations (version) VALUES (?)').run(m.version);
    })();
  }

  return db;
}

// ---------------------------------------------------------------------------
// Installs CRUD
// ---------------------------------------------------------------------------

function createInstall({ id, manageTokenHash, stremioAuthKeyEnc, traktAccessTokenEnc, traktRefreshTokenEnc, traktExpiresAt }) {
  db.prepare(`
    INSERT INTO installs (id, manage_token_hash, stremio_auth_key_enc, trakt_access_token_enc, trakt_refresh_token_enc, trakt_expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, manageTokenHash, stremioAuthKeyEnc || null, traktAccessTokenEnc || null, traktRefreshTokenEnc || null, traktExpiresAt || null);
}

function rowToInstall(row) {
  if (!row) return null;
  return {
    id: row.id,
    manageTokenHash: row.manage_token_hash,
    stremioAuthKeyEnc: row.stremio_auth_key_enc,
    traktAccessTokenEnc: row.trakt_access_token_enc,
    traktRefreshTokenEnc: row.trakt_refresh_token_enc,
    traktExpiresAt: row.trakt_expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getInstall(id) {
  const row = db.prepare('SELECT * FROM installs WHERE id = ?').get(id);
  return rowToInstall(row);
}

// Map of camelCase field names to their snake_case column equivalents.
const installColumnMap = {
  manageTokenHash: 'manage_token_hash',
  stremioAuthKeyEnc: 'stremio_auth_key_enc',
  traktAccessTokenEnc: 'trakt_access_token_enc',
  traktRefreshTokenEnc: 'trakt_refresh_token_enc',
  traktExpiresAt: 'trakt_expires_at',
};

function updateInstall(id, data) {
  const sets = [];
  const values = [];

  for (const [key, value] of Object.entries(data)) {
    const col = installColumnMap[key];
    if (!col) continue;
    sets.push(`${col} = ?`);
    values.push(value);
  }

  if (sets.length === 0) return;

  sets.push('updated_at = unixepoch()');
  values.push(id);

  db.prepare(`UPDATE installs SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}

function deleteInstall(id) {
  db.prepare('DELETE FROM installs WHERE id = ?').run(id);
}

// ---------------------------------------------------------------------------
// Recommendation Cache
// ---------------------------------------------------------------------------

function getCachedRecs(installId, type) {
  const row = db.prepare(
    'SELECT ranked_json, computed_at, library_freshness, build_depth, build_budget, build_ok FROM recommendation_cache WHERE install_id = ? AND type = ?',
  ).get(installId, type);
  if (!row) return null;
  return {
    rankedJson: row.ranked_json,
    computedAt: row.computed_at,
    libraryFreshness: row.library_freshness,
    buildDepth: row.build_depth || 0,
    buildBudget: row.build_budget || 0,
    buildOk: !!row.build_ok,
  };
}

function clearCacheForInstall(installId) {
  db.prepare('DELETE FROM recommendation_cache WHERE install_id = ?').run(installId);
  db.prepare('DELETE FROM library_freshness WHERE install_id = ?').run(installId);
}

function setCachedRecs(installId, type, rankedJson, libraryFreshness, buildDepth, buildBudget, buildOk) {
  db.prepare(`
    INSERT OR REPLACE INTO recommendation_cache (install_id, type, ranked_json, computed_at, library_freshness, build_depth, build_budget, build_ok)
    VALUES (?, ?, ?, unixepoch(), ?, ?, ?, ?)
  `).run(installId, type, rankedJson, libraryFreshness, buildDepth, buildBudget, buildOk);
}

// ---------------------------------------------------------------------------
// Library Freshness
// ---------------------------------------------------------------------------

function getFreshness(installId, type) {
  const row = db.prepare('SELECT * FROM library_freshness WHERE install_id = ? AND type = ?').get(installId, type);
  if (!row) return null;
  return {
    installId: row.install_id,
    type: row.type,
    stremioMaxMtime: row.stremio_max_mtime,
    traktMoviesLastWatchedAt: row.trakt_movies_last_watched_at,
    traktShowsLastWatchedAt: row.trakt_shows_last_watched_at,
    checkedAt: row.checked_at,
  };
}

function setFreshness(installId, type, { stremioMaxMtime, traktMoviesLastWatchedAt, traktShowsLastWatchedAt }) {
  db.prepare(`
    INSERT OR REPLACE INTO library_freshness (install_id, type, stremio_max_mtime, trakt_movies_last_watched_at, trakt_shows_last_watched_at, checked_at)
    VALUES (?, ?, ?, ?, ?, unixepoch())
  `).run(installId, type, stremioMaxMtime || null, traktMoviesLastWatchedAt || null, traktShowsLastWatchedAt || null);
}

// ---------------------------------------------------------------------------
// Events (analytics — best-effort, never throw)
// ---------------------------------------------------------------------------

function logEvent({ event, installId, meta }) {
  try {
    db.prepare(
      'INSERT INTO events (event, install_id, meta) VALUES (?, ?, ?)',
    ).run(event, installId || null, meta ? String(meta).slice(0, 1024) : null);
  } catch (_) {
    // Best-effort: a failed logEvent must never break onboarding.
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  initDb,
  createInstall,
  getInstall,
  updateInstall,
  deleteInstall,
  getCachedRecs,
  setCachedRecs,
  clearCacheForInstall,
  getFreshness,
  setFreshness,
  logEvent,
};
