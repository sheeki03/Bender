"use strict";

const API_BASE = "https://api.strem.io";

/**
 * Log in to Stremio with email and password.
 * @param {string} email
 * @param {string} password
 * @returns {Promise<{authKey: string, user: object}>}
 */
async function login(email, password) {
  const res = await fetch(`${API_BASE}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "Login",
      email,
      password,
      facebook: false,
    }),
  });

  const data = await res.json();

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
  const res = await fetch(`${API_BASE}/api/datastoreGet`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      authKey,
      collection: "libraryItem",
      all: true,
      ids: [],
    }),
  });

  const data = await res.json();

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
  try {
    const res = await fetch(`${API_BASE}/api/loginWithToken`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "LoginWithToken",
        token: authKey,
      }),
    });

    const data = await res.json();

    return !data.error;
  } catch {
    return false;
  }
}

/**
 * Fetch library datastore metadata (mtime info for cache invalidation).
 * @param {string} authKey
 * @returns {Promise<object>} Metadata result — caller extracts max(mtime)
 */
async function fetchLibraryMeta(authKey) {
  const res = await fetch(`${API_BASE}/api/datastoreMeta`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      authKey,
      collection: "libraryItem",
    }),
  });

  const data = await res.json();

  if (data.error) {
    throw new Error(data.error.message || "Failed to fetch library metadata");
  }

  return data.result;
}

module.exports = { login, fetchLibrary, validateKey, fetchLibraryMeta };
