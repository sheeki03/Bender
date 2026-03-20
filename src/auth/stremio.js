"use strict";

const API_BASE = "https://api.strem.io";

async function safeStremioFetch(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error(`Stremio API returned non-JSON response (HTTP ${res.status})`);
  }
  // Stremio uses { result, error } JSON-RPC shape. If the body parsed as JSON
  // but doesn't match that shape and the status is not OK, treat as infra error.
  if (!res.ok && data.result === undefined && data.error === undefined) {
    throw new Error(`Stremio API returned unexpected JSON (HTTP ${res.status})`);
  }
  return data;
}

/**
 * Log in to Stremio with email and password.
 * @param {string} email
 * @param {string} password
 * @returns {Promise<{authKey: string, user: object}>}
 */
async function login(email, password) {
  const data = await safeStremioFetch(`${API_BASE}/api/login`, {
    type: "Login",
    email,
    password,
    facebook: false,
  });

  if (data.error) {
    throw new Error(data.error.message || "Login failed");
  }

  return { authKey: data.result.authKey, user: data.result.user };
}

/**
 * Fetch the full library for an authenticated user.
 * @param {string} authKey
 * @returns {Promise<object[]>} Array of LibraryItem objects
 */
async function fetchLibrary(authKey) {
  const data = await safeStremioFetch(`${API_BASE}/api/datastoreGet`, {
    authKey,
    collection: "libraryItem",
    all: true,
    ids: [],
  });

  if (data.error) {
    throw new Error(data.error.message || "Failed to fetch library");
  }

  return data.result;
}

/**
 * Validate whether an authKey is still valid.
 * @param {string} authKey
 * @returns {Promise<boolean>}
 */
async function validateKey(authKey) {
  const data = await safeStremioFetch(`${API_BASE}/api/loginWithToken`, {
    type: "LoginWithToken",
    token: authKey,
  });

  return !data.error;
}

/**
 * Fetch library datastore metadata (mtime info for cache invalidation).
 * @param {string} authKey
 * @returns {Promise<object>} Metadata result — caller extracts max(mtime)
 */
async function fetchLibraryMeta(authKey) {
  const data = await safeStremioFetch(`${API_BASE}/api/datastoreMeta`, {
    authKey,
    collection: "libraryItem",
  });

  if (data.error) {
    throw new Error(data.error.message || "Failed to fetch library metadata");
  }

  return data.result;
}

module.exports = { login, fetchLibrary, validateKey, fetchLibraryMeta };
