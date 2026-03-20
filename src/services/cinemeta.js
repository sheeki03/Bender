'use strict';

const { cinemetaCache } = require('../utils/cache');

const BASE_URL = 'https://v3-cinemeta.strem.io';
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Run async functions over items with a concurrency limit.
 */
async function withConcurrency(items, limit, fn) {
  const results = [];
  const executing = new Set();
  for (const item of items) {
    const p = fn(item).then((r) => {
      executing.delete(p);
      return r;
    });
    executing.add(p);
    results.push(p);
    if (executing.size >= limit) await Promise.race(executing);
  }
  return Promise.all(results);
}

/**
 * Fetch metadata for a single title from Cinemeta.
 *
 * @param {string} type  - "movie" or "series"
 * @param {string} imdbId - e.g. "tt1234567"
 * @returns {Promise<object|null>} The meta object, or null on failure.
 */
async function getMeta(type, imdbId) {
  const cacheKey = `${type}:${imdbId}`;
  const cached = cinemetaCache.get(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const url = `${BASE_URL}/meta/${type}/${imdbId}.json`;
    const res = await fetch(url);

    if (!res.ok) return null;

    const data = await res.json();
    const meta = data && data.meta ? data.meta : null;

    if (meta) {
      cinemetaCache.set(cacheKey, meta, CACHE_TTL);
    }

    return meta;
  } catch {
    return null;
  }
}

/**
 * Batch-fetch metadata for an array of IMDb IDs with limited concurrency.
 *
 * @param {string}   type    - "movie" or "series"
 * @param {string[]} imdbIds - Array of IMDb IDs
 * @returns {Promise<Map<string, object>>} Map of imdbId to meta object (successful fetches only).
 */
async function enrichMetas(type, imdbIds) {
  const results = new Map();

  await withConcurrency(imdbIds, 5, async (imdbId) => {
    const meta = await getMeta(type, imdbId);
    if (meta) {
      results.set(imdbId, meta);
    }
  });

  return results;
}

module.exports = { getMeta, enrichMetas };
