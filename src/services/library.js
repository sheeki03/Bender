"use strict";

/**
 * Source-aware library merger.
 *
 * Merges watch history from Stremio and Trakt into a normalized format,
 * preserving per-source engagement metrics and deduplicating by IMDb ID.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, 0), 1);
}

function maxDate(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return a >= b ? a : b;
}

function hasEngagement(state) {
  if (!state) return false;
  const watched =
    (state.overallTimeWatched || state.timeWatched || 0) > 0 ||
    (state.timesWatched || 0) > 0;
  const flagged = !!state.flaggedWatched;
  return watched || flagged;
}

// ---------------------------------------------------------------------------
// normalizeStremioLibrary
// ---------------------------------------------------------------------------

function normalizeStremioLibrary(items) {
  if (!Array.isArray(items)) return [];

  return items
    .filter((item) => {
      if (!item || item.removed === true) return false;
      if (item.type === "other") return false;
      if (!item._id || !item._id.startsWith("tt")) return false;
      return hasEngagement(item.state);
    })
    .map((item) => {
      const state = item.state || {};
      const overallTimeWatched =
        state.overallTimeWatched || state.timeWatched || 0;
      const duration = state.duration || 0;
      const completionRate =
        duration > 0 ? clamp01(overallTimeWatched / duration) : 0;

      let skipSignal = 0;
      if (item.type === 'movie' && duration > 0) {
        if (completionRate >= 0.7) {
          skipSignal = 0;
        } else if (completionRate < 0.15) {
          skipSignal = 1.0;
        } else if (completionRate < 0.35) {
          skipSignal = 0.7;
        } else {
          skipSignal = 0.3;
        }
      }

      return {
        imdbId: item._id,
        name: item.name || null,
        type: item.type,
        poster: item.poster || null,
        sources: ["stremio"],
        engagement: {
          timesWatched: state.timesWatched || 0,
          overallTimeWatched,
          duration,
          timeOffset: state.timeOffset || 0,
          lastWatched: state.lastWatched ? new Date(state.lastWatched) : null,
          flaggedWatched: state.flaggedWatched ? 1 : 0,
          completionRate,
          skipSignal,
        },
      };
    });
}

// ---------------------------------------------------------------------------
// normalizeTraktItems (shared logic for movies and shows)
// ---------------------------------------------------------------------------

/**
 * Normalize a Trakt watched list into the common library format.
 * @param {Array}  items    - Raw Trakt API response items.
 * @param {string} innerKey - Key on each item containing the media object ("movie" or "show").
 * @param {string} type     - Normalized type for output ("movie" or "series").
 */
function normalizeTraktItems(items, innerKey, type) {
  if (!Array.isArray(items)) return [];

  return items
    .filter((item) => {
      const inner = item && item[innerKey];
      return inner && inner.ids && inner.ids.imdb;
    })
    .map((item) => {
      const inner = item[innerKey];
      const plays = item.plays || 0;

      return {
        imdbId: inner.ids.imdb,
        name: inner.title || null,
        type,
        poster: null,
        sources: ["trakt"],
        engagement: {
          timesWatched: plays,
          overallTimeWatched: 0,
          duration: 0,
          timeOffset: 0,
          lastWatched: item.last_watched_at
            ? new Date(item.last_watched_at)
            : null,
          flaggedWatched: 0,
          completionRate: plays > 0 ? 1.0 : 0,
        },
      };
    });
}

function normalizeTraktMovies(items) {
  return normalizeTraktItems(items, 'movie', 'movie');
}

function normalizeTraktShows(items) {
  return normalizeTraktItems(items, 'show', 'series');
}

// ---------------------------------------------------------------------------
// mergeLibraries
// ---------------------------------------------------------------------------

function mergeLibraries(stremioItems, traktItems) {
  const stremio = Array.isArray(stremioItems) ? stremioItems : [];
  const trakt = Array.isArray(traktItems) ? traktItems : [];

  const map = new Map();

  for (const item of stremio) {
    map.set(item.imdbId, item);
  }

  for (const traktItem of trakt) {
    const existing = map.get(traktItem.imdbId);

    if (!existing) {
      map.set(traktItem.imdbId, traktItem);
      continue;
    }

    // Merge: prefer existing item's Stremio-sourced engagement fields.
    const sEng = existing.engagement;
    const tEng = traktItem.engagement;

    map.set(traktItem.imdbId, {
      imdbId: existing.imdbId,
      name: existing.name || traktItem.name,
      type: existing.type,
      poster: existing.poster || traktItem.poster,
      sources: ["stremio", "trakt"],
      engagement: {
        timesWatched: Math.max(sEng.timesWatched, tEng.timesWatched),
        overallTimeWatched: sEng.overallTimeWatched,
        duration: sEng.duration,
        timeOffset: sEng.timeOffset,
        lastWatched: maxDate(sEng.lastWatched, tEng.lastWatched),
        flaggedWatched: sEng.flaggedWatched,
        completionRate:
          sEng.completionRate > 0
            ? sEng.completionRate
            : tEng.completionRate,
        skipSignal: sEng.skipSignal || 0,
      },
    });
  }

  return Array.from(map.values());
}

// ---------------------------------------------------------------------------
// getMaxLastWatched
// ---------------------------------------------------------------------------

function getMaxLastWatched(items) {
  if (!Array.isArray(items) || items.length === 0) return null;

  let max = null;

  for (const item of items) {
    const lw = item.engagement && item.engagement.lastWatched;
    if (lw) {
      max = maxDate(max, lw);
    }
  }

  return max;
}

// ---------------------------------------------------------------------------
// normalizeTraktRatings
// ---------------------------------------------------------------------------

function normalizeTraktRatings(ratedMovies, ratedShows) {
  const ratings = new Map();

  function processGroup(items, type, extractItem) {
    const rawValues = [];
    const entries = [];
    for (const item of items) {
      const inner = extractItem(item);
      if (!inner || !inner.ids || !inner.ids.imdb) continue;
      const raw = item.rating;
      if (typeof raw !== 'number' || raw < 1 || raw > 10) continue;
      rawValues.push(raw);
      entries.push({
        imdbId: inner.ids.imdb,
        raw,
        ratedAt: item.rated_at || null,
      });
    }

    if (entries.length === 0) return;

    // Per-type z-score normalization
    const mean = rawValues.reduce((s, v) => s + v, 0) / rawValues.length;
    const variance = rawValues.reduce((s, v) => s + (v - mean) ** 2, 0) / rawValues.length;
    const std = Math.sqrt(variance);

    const typeCount = entries.length;
    const shrinkage = Math.min(typeCount / 5, 1.0);
    const varianceConfidence = Math.min(Math.max((std - 1.0) / 1.5, 0), 1.0);

    for (const entry of entries) {
      const zScore = std > 0 ? (entry.raw - mean) / std : 0;
      const polarityFallback = (entry.raw - 6) / 4;
      let normalized = varianceConfidence * zScore + (1 - varianceConfidence) * polarityFallback;
      normalized = Math.max(-1, Math.min(1, normalized));
      normalized *= shrinkage;

      ratings.set(entry.imdbId, {
        type,
        rating: normalized,
        ratedAt: entry.ratedAt,
      });
    }
  }

  processGroup(ratedMovies || [], 'movie', (item) => item.movie);
  processGroup(ratedShows || [], 'series', (item) => item.show);

  return ratings;
}

// ---------------------------------------------------------------------------
// annotateRatings
// ---------------------------------------------------------------------------

function annotateRatings(mergedItems, traktRatings) {
  if (!traktRatings || traktRatings.size === 0) {
    return { mergedItems, profileOnlyItems: [] };
  }

  const seenIds = new Set();

  // Annotate existing items (type-matched only)
  for (const item of mergedItems) {
    seenIds.add(item.imdbId);
    const entry = traktRatings.get(item.imdbId);
    if (entry && entry.type === item.type) {
      item.engagement.traktRating = entry.rating;
      item.engagement.ratedAt = entry.ratedAt;
    }
  }

  // Inject profile-only items (rated but not in library)
  const profileOnlyItems = [];
  for (const [imdbId, entry] of traktRatings) {
    if (seenIds.has(imdbId)) continue;
    profileOnlyItems.push({
      imdbId,
      name: null,
      type: entry.type,
      poster: null,
      sources: ['trakt-rating'],
      engagement: {
        timesWatched: 0,
        overallTimeWatched: 0,
        duration: 0,
        timeOffset: 0,
        lastWatched: null,
        flaggedWatched: 0,
        completionRate: 0,
        skipSignal: 0,
        traktRating: entry.rating,
        ratedAt: entry.ratedAt,
      },
    });
  }

  return { mergedItems, profileOnlyItems };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  normalizeStremioLibrary,
  normalizeTraktMovies,
  normalizeTraktShows,
  mergeLibraries,
  getMaxLastWatched,
  normalizeTraktRatings,
  annotateRatings,
};
