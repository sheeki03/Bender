'use strict';

const { config } = require('../config');

const TRAKT_API_BASE = 'https://api.trakt.tv';
const REFRESH_BUFFER_SECONDS = 7 * 24 * 60 * 60; // 7 days

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function redirectUri() {
  return `${config.baseUrl}/trakt/callback`;
}

function traktHeaders(accessToken) {
  const headers = {
    'Content-Type': 'application/json',
    'trakt-api-version': '2',
    'trakt-api-key': config.traktClientId,
  };
  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`;
  }
  return headers;
}

// ---------------------------------------------------------------------------
// OAuth helpers
// ---------------------------------------------------------------------------

/**
 * Build the Trakt OAuth authorization URL.
 * @param {string} state – opaque state parameter for CSRF protection
 * @returns {string}
 */
function getAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: config.traktClientId,
    redirect_uri: redirectUri(),
    response_type: 'code',
    state,
  });
  return `https://trakt.tv/oauth/authorize?${params.toString()}`;
}

/**
 * Exchange an authorization code for tokens.
 * @param {string} code
 * @returns {Promise<{access_token: string, refresh_token: string, expires_in: number, created_at: number}>}
 */
async function exchangeCode(code) {
  const res = await fetch(`${TRAKT_API_BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code,
      client_id: config.traktClientId,
      client_secret: config.traktClientSecret,
      redirect_uri: redirectUri(),
      grant_type: 'authorization_code',
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Trakt exchangeCode failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_in: data.expires_in,
    created_at: data.created_at,
  };
}

/**
 * Refresh an expired (or expiring) token.
 * @param {string} token - The refresh token to exchange
 * @returns {Promise<{access_token: string, refresh_token: string, expires_in: number, created_at: number}>}
 */
async function refreshToken(token) {
  const res = await fetch(`${TRAKT_API_BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      refresh_token: token,
      client_id: config.traktClientId,
      client_secret: config.traktClientSecret,
      redirect_uri: redirectUri(),
      grant_type: 'refresh_token',
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Trakt refreshToken failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_in: data.expires_in,
    created_at: data.created_at,
  };
}

/**
 * Refresh the Trakt access token if it expires within 7 days.
 *
 * Dependency-injected helpers avoid circular imports:
 *   - getInstall(id)        – fetch the install row from the DB
 *   - updateInstall(id, {}) – persist updated token fields
 *   - encrypt(plaintext)    – encrypt a string for storage
 *
 * @param {object} install – DB row with traktExpiresAt, traktRefreshTokenEnc, etc.
 * @param {{getInstall: Function, updateInstall: Function, encrypt: Function, decrypt: Function}} deps
 * @returns {Promise<object>} the (potentially refreshed) install
 */
async function refreshIfNeeded(install, { getInstall, updateInstall, encrypt, decrypt }) {
  if (!install.traktExpiresAt) {
    return install;
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const expiresAt = install.traktExpiresAt;

  if (expiresAt - nowSeconds > REFRESH_BUFFER_SECONDS) {
    // Token is still fresh — nothing to do.
    return install;
  }

  // Decrypt the stored refresh token and request new tokens.
  const oldRefreshToken = decrypt(install.traktRefreshTokenEnc);
  const tokens = await refreshToken(oldRefreshToken);

  const newExpiresAt = tokens.created_at + tokens.expires_in;

  await updateInstall(install.id, {
    traktAccessTokenEnc: encrypt(tokens.access_token),
    traktRefreshTokenEnc: encrypt(tokens.refresh_token),
    traktExpiresAt: newExpiresAt,
  });

  // Return the refreshed install so the caller has up-to-date fields.
  return getInstall(install.id);
}

// ---------------------------------------------------------------------------
// Watch history
// ---------------------------------------------------------------------------

/**
 * Paginate through a Trakt list endpoint, accumulating all pages.
 * When maxPages is Infinity (the default), fetches all available pages.
 * @param {string} url – base URL (without page/limit params)
 * @param {string} accessToken
 * @param {number} maxPages – stop after this many pages (default: all)
 * @returns {Promise<Array>}
 */
const ABSOLUTE_PAGE_LIMIT = 500;

async function paginateTrakt(url, accessToken, maxPages = Infinity) {
  const effectiveMax = Math.min(maxPages, ABSOLUTE_PAGE_LIMIT);
  const results = [];
  let page = 1;

  while (page <= effectiveMax) {
    const separator = url.includes('?') ? '&' : '?';
    const pagedUrl = `${url}${separator}page=${page}&limit=100`;

    const res = await fetch(pagedUrl, {
      method: 'GET',
      headers: traktHeaders(accessToken),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Trakt API request failed (${res.status}): ${text}`);
    }

    const data = await res.json();
    if (!Array.isArray(data)) {
      throw new Error(`Trakt API returned non-array response on page ${page}`);
    }
    if (data.length === 0) break;
    results.push(...data);

    const totalPages = parseInt(res.headers.get('X-Pagination-Page-Count'), 10) || 1;
    if (page >= totalPages) break;
    page++;
  }

  return results;
}

/**
 * Fetch all watched movies for the authenticated user.
 * @param {string} accessToken
 * @returns {Promise<Array>}
 */
async function fetchWatchedMovies(accessToken) {
  return paginateTrakt(`${TRAKT_API_BASE}/users/me/watched/movies`, accessToken);
}

/**
 * Fetch all watched shows for the authenticated user.
 * @param {string} accessToken
 * @returns {Promise<Array>}
 */
async function fetchWatchedShows(accessToken) {
  return paginateTrakt(`${TRAKT_API_BASE}/users/me/watched/shows`, accessToken);
}

/**
 * Fetch rated movies for the authenticated user (newest ratings first, capped).
 * @param {string} accessToken
 * @returns {Promise<Array>}
 */
async function fetchRatedMovies(accessToken) {
  return paginateTrakt(
    `${TRAKT_API_BASE}/users/me/ratings/movies?sort=rated&sort_how=desc`,
    accessToken,
    5,
  );
}

/**
 * Fetch rated shows for the authenticated user (newest ratings first, capped).
 * @param {string} accessToken
 * @returns {Promise<Array>}
 */
async function fetchRatedShows(accessToken) {
  return paginateTrakt(
    `${TRAKT_API_BASE}/users/me/ratings/shows?sort=rated&sort_how=desc`,
    accessToken,
    5,
  );
}

/**
 * Fetch the single most recent history entry for the given type.
 * The Trakt history endpoint returns newest-first by default.
 *
 * @param {string} accessToken
 * @param {"movies"|"shows"} type
 * @returns {Promise<object|null>} the most recent entry, or null if none
 */
async function fetchRecentHistory(accessToken, type) {
  const res = await fetch(
    `${TRAKT_API_BASE}/users/me/history/${type}?limit=1`,
    {
      method: 'GET',
      headers: traktHeaders(accessToken),
    },
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Trakt fetchRecentHistory failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  return data.length > 0 ? data[0] : null;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  getAuthUrl,
  exchangeCode,
  refreshToken,
  refreshIfNeeded,
  paginateTrakt,
  fetchWatchedMovies,
  fetchWatchedShows,
  fetchRatedMovies,
  fetchRatedShows,
  fetchRecentHistory,
};
