'use strict';

const { config } = require('../config');
const { tmdbCache, tmdbIdCache } = require('../utils/cache');
const { tmdbLimiter } = require('../utils/rateLimiter');

const BASE_URL = 'https://api.themoviedb.org/3';
const IMAGE_BASE = 'https://image.tmdb.org/t/p/w500';

const TTL_24H = 24 * 60 * 60 * 1000;
const TTL_7D = 7 * 24 * 60 * 60 * 1000;

/**
 * Map Stremio / caller type strings to TMDB path segments.
 * "series" → "tv"; "movie" and "tv" pass through unchanged.
 */
function mapType(type) {
  if (type === 'series') return 'tv';
  return type;
}

/**
 * Return a full poster URL, or null when the path is missing.
 */
function posterUrl(posterPath) {
  if (!posterPath) return null;
  return `${IMAGE_BASE}${posterPath}`;
}

/**
 * Internal helper that wraps every TMDB fetch with:
 *   1. Cache check
 *   2. Rate-limit acquire
 *   3. Fetch
 *   4. 429 back-off + single retry
 *   5. Cache on success
 *   6. Return data or null
 *
 * @param {string}  path       - TMDB API path (e.g. "/find/tt1234567")
 * @param {object}  cacheStore - Cache instance to use (tmdbCache or tmdbIdCache)
 * @param {string}  cacheKey   - Key for the cache entry
 * @param {number}  ttl        - TTL in milliseconds
 * @returns {Promise<any|null>}
 */
async function tmdbFetch(path, cacheStore, cacheKey, ttl) {
  const cached = cacheStore.get(cacheKey);
  if (cached !== undefined) return cached;

  await tmdbLimiter.acquire();

  const separator = path.includes('?') ? '&' : '?';
  const url = `${BASE_URL}${path}${separator}api_key=${config.tmdbApiKey}`;

  try {
    let res = await fetch(url);

    if (res.status === 429) {
      const retryAfter = parseFloat(res.headers.get('retry-after')) || undefined;
      tmdbLimiter.backoff(retryAfter);
      await new Promise((r) => setTimeout(r, (retryAfter || 2) * 1000));
      await tmdbLimiter.acquire();
      res = await fetch(url);
    }

    if (!res.ok) {
      console.error(`[tmdb] ${res.status} ${res.statusText} – ${path}`);
      return null;
    }

    const data = await res.json();
    cacheStore.set(cacheKey, data, ttl);
    return data;
  } catch (err) {
    console.error(`[tmdb] fetch error – ${path}:`, err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Look up a TMDB ID by IMDb ID.
 * Returns { tmdbId, type } or null when the title is not in TMDB.
 * Throws when the TMDB fetch itself failed (HTTP/network error).
 */
async function findByImdbId(imdbId) {
  const cacheKey = `find:${imdbId}`;
  const data = await tmdbFetch(
    `/find/${imdbId}?external_source=imdb_id`,
    tmdbIdCache,
    cacheKey,
    TTL_7D,
  );
  if (data === null) {
    throw new Error(`TMDB /find fetch failed for ${imdbId}`);
  }

  if (data.movie_results && data.movie_results.length > 0) {
    return { tmdbId: data.movie_results[0].id, type: 'movie' };
  }
  if (data.tv_results && data.tv_results.length > 0) {
    return { tmdbId: data.tv_results[0].id, type: 'tv' };
  }

  return null;
}

/**
 * Get recommended titles for a given TMDB ID.
 * Returns an array of result objects, or [].
 */
async function getRecommendations(tmdbId, type) {
  const t = mapType(type);
  const cacheKey = `rec:${t}:${tmdbId}`;
  const data = await tmdbFetch(
    `/${t}/${tmdbId}/recommendations`,
    tmdbCache,
    cacheKey,
    TTL_24H,
  );
  return (data && data.results) || [];
}

/**
 * Get similar titles for a given TMDB ID.
 * Returns an array of result objects, or [].
 */
async function getSimilar(tmdbId, type) {
  const t = mapType(type);
  const cacheKey = `sim:${t}:${tmdbId}`;
  const data = await tmdbFetch(
    `/${t}/${tmdbId}/similar`,
    tmdbCache,
    cacheKey,
    TTL_24H,
  );
  return (data && data.results) || [];
}

/**
 * Get external IDs (incl. imdb_id) for a TMDB title.
 * Returns the external-ids object, or null.
 */
async function getExternalIds(tmdbId, type) {
  const t = mapType(type);
  const cacheKey = `ext:${t}:${tmdbId}`;
  const data = await tmdbFetch(
    `/${t}/${tmdbId}/external_ids`,
    tmdbIdCache,
    cacheKey,
    TTL_7D,
  );
  return data || null;
}

/**
 * Discover titles by genre, popularity, etc.
 * `params` is merged into the query string.
 * Returns an array of result objects, or [].
 */
async function discover(type, params) {
  const t = mapType(type);
  const cacheKey = `disc:${t}:${JSON.stringify(params)}`;

  const defaults = {
    sort_by: 'popularity.desc',
    'vote_count.gte': '100',
    include_adult: 'false',
  };

  const merged = { ...defaults, ...params };
  const qs = Object.entries(merged)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

  const data = await tmdbFetch(
    `/discover/${t}?${qs}`,
    tmdbCache,
    cacheKey,
    TTL_24H,
  );
  return (data && data.results) || [];
}

/**
 * Get trending titles for the week.
 * Returns an array of result objects, or [].
 */
async function getTrending(type) {
  const t = mapType(type);
  const cacheKey = `trend:${t}`;
  const data = await tmdbFetch(
    `/trending/${t}/week`,
    tmdbCache,
    cacheKey,
    TTL_24H,
  );
  return (data && data.results) || [];
}

/**
 * Get the genre list for movies or TV.
 * Returns an array of { id, name } objects.
 */
async function getGenres(type) {
  const t = mapType(type);
  const cacheKey = `genres:${t}`;
  const data = await tmdbFetch(
    `/genre/${t}/list`,
    tmdbIdCache,
    cacheKey,
    TTL_7D,
  );
  return (data && data.genres) || [];
}

/**
 * Paged variant of getRecommendations.
 * Returns { items: Array, hadFailures: boolean }.
 */
async function getRecommendationsPaged(tmdbId, type, maxPages = 1) {
  const t = mapType(type);
  const items = [];
  let hadFailures = false;
  for (let page = 1; page <= maxPages; page++) {
    const cacheKey = `rec:${t}:${tmdbId}:p${page}`;
    const data = await tmdbFetch(
      `/${t}/${tmdbId}/recommendations?page=${page}`,
      tmdbCache,
      cacheKey,
      TTL_24H,
    );
    if (!data) { hadFailures = true; break; }
    if (!data.results || data.results.length === 0) break;
    items.push(...data.results);
    if (page >= (data.total_pages || 1)) break;
  }
  return { items, hadFailures };
}

/**
 * Paged variant of getSimilar.
 * Returns { items: Array, hadFailures: boolean }.
 */
async function getSimilarPaged(tmdbId, type, maxPages = 1) {
  const t = mapType(type);
  const items = [];
  let hadFailures = false;
  for (let page = 1; page <= maxPages; page++) {
    const cacheKey = `sim:${t}:${tmdbId}:p${page}`;
    const data = await tmdbFetch(
      `/${t}/${tmdbId}/similar?page=${page}`,
      tmdbCache,
      cacheKey,
      TTL_24H,
    );
    if (!data) { hadFailures = true; break; }
    if (!data.results || data.results.length === 0) break;
    items.push(...data.results);
    if (page >= (data.total_pages || 1)) break;
  }
  return { items, hadFailures };
}

/**
 * Paged variant of discover.
 * Returns { items: Array, hadFailures: boolean }.
 */
async function discoverPaged(type, params, maxPages = 1) {
  const t = mapType(type);
  const defaults = {
    sort_by: 'popularity.desc',
    'vote_count.gte': '100',
    include_adult: 'false',
  };
  const merged = { ...defaults, ...params };
  const qs = Object.entries(merged)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

  const items = [];
  let hadFailures = false;
  for (let page = 1; page <= maxPages; page++) {
    const cacheKey = `disc:${t}:${JSON.stringify(params)}:p${page}`;
    const data = await tmdbFetch(
      `/discover/${t}?${qs}&page=${page}`,
      tmdbCache,
      cacheKey,
      TTL_24H,
    );
    if (!data) { hadFailures = true; break; }
    if (!data.results || data.results.length === 0) break;
    items.push(...data.results);
    if (page >= (data.total_pages || 1)) break;
  }
  return { items, hadFailures };
}

/**
 * Paged variant of getTrending.
 * Returns { items: Array, hadFailures: boolean }.
 */
async function getTrendingPaged(type, maxPages = 1) {
  const t = mapType(type);
  const items = [];
  let hadFailures = false;
  for (let page = 1; page <= maxPages; page++) {
    const cacheKey = `trend:${t}:p${page}`;
    const data = await tmdbFetch(
      `/trending/${t}/week?page=${page}`,
      tmdbCache,
      cacheKey,
      TTL_24H,
    );
    if (!data) { hadFailures = true; break; }
    if (!data.results || data.results.length === 0) break;
    items.push(...data.results);
    if (page >= (data.total_pages || 1)) break;
  }
  return { items, hadFailures };
}

module.exports = {
  findByImdbId,
  getRecommendations,
  getSimilar,
  getExternalIds,
  discover,
  getTrending,
  getGenres,
  posterUrl,
  mapType,
  getRecommendationsPaged,
  getSimilarPaged,
  discoverPaged,
  getTrendingPaged,
};
