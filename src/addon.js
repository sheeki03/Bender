const { addonBuilder } = require('stremio-addon-sdk');

const manifest = {
  id: "community.bender",
  version: "1.0.0",
  name: "Bender",
  description: "Personalized movie & TV recommendations based on your watch history",
  resources: ["catalog"],
  types: ["movie", "series"],
  idPrefixes: ["tt"],
  catalogs: [
    {
      type: "movie",
      id: "bender-movies",
      name: "Bender's Movies",
      extra: [
        { name: "genre", isRequired: false },
        { name: "skip", isRequired: false }
      ]
    },
    {
      type: "series",
      id: "bender-series",
      name: "Bender's Series",
      extra: [
        { name: "genre", isRequired: false },
        { name: "skip", isRequired: false }
      ]
    }
  ],
  config: [
    { key: "installId", type: "text", required: true }
  ],
  behaviorHints: { configurable: true, configurationRequired: true }
};

const builder = new addonBuilder(manifest);

// ---------------------------------------------------------------------------
// TMDB genre lookups
// ---------------------------------------------------------------------------

const TMDB_MOVIE_GENRES = {
  28: 'Action',
  12: 'Adventure',
  16: 'Animation',
  35: 'Comedy',
  80: 'Crime',
  99: 'Documentary',
  18: 'Drama',
  10751: 'Family',
  14: 'Fantasy',
  36: 'History',
  27: 'Horror',
  10402: 'Music',
  9648: 'Mystery',
  10749: 'Romance',
  878: 'Science Fiction',
  10770: 'TV Movie',
  53: 'Thriller',
  10752: 'War',
  37: 'Western'
};

const TMDB_TV_GENRES = {
  10759: 'Action & Adventure',
  16: 'Animation',
  35: 'Comedy',
  80: 'Crime',
  99: 'Documentary',
  18: 'Drama',
  10751: 'Family',
  10762: 'Kids',
  9648: 'Mystery',
  10763: 'News',
  10764: 'Reality',
  10765: 'Sci-Fi & Fantasy',
  10766: 'Soap',
  10767: 'Talk',
  10768: 'War & Politics',
  37: 'Western'
};

const ALL_GENRES = Object.assign({}, TMDB_MOVIE_GENRES, TMDB_TV_GENRES);

// ---------------------------------------------------------------------------
// Helper: genreNameMatches
// ---------------------------------------------------------------------------

function genreNameMatches(genreId, genreName) {
  const mapped = ALL_GENRES[genreId];
  if (!mapped) return false;
  return mapped.toLowerCase() === genreName.toLowerCase();
}

// ---------------------------------------------------------------------------
// Helper: posterUrl  (TMDB poster path -> full URL)
// ---------------------------------------------------------------------------

function posterUrl(posterPath) {
  if (!posterPath) return '';
  return `https://image.tmdb.org/t/p/w500${posterPath}`;
}

// ---------------------------------------------------------------------------
// Helper: extractMaxMtime — parse Stremio datastoreMeta response
// ---------------------------------------------------------------------------

function extractMaxMtime(meta) {
  if (!meta) return null;
  // datastoreMeta may return an array of {_id, mtime} or an object with mtime
  if (Array.isArray(meta)) {
    let max = null;
    for (const entry of meta) {
      if (entry && entry.mtime && (!max || entry.mtime > max)) {
        max = entry.mtime;
      }
    }
    return max;
  }
  if (meta.mtime) return meta.mtime;
  return null;
}

// ---------------------------------------------------------------------------
// Helper: runPipeline
// ---------------------------------------------------------------------------

async function runPipeline(install, type, db, decrypt, resolveTarget) {
  const { fetchLibrary } = require('./auth/stremio');
  const { fetchWatchedMovies, fetchWatchedShows, fetchRatedMovies, fetchRatedShows } = require('./auth/trakt');
  const {
    normalizeStremioLibrary,
    normalizeTraktMovies,
    normalizeTraktShows,
    mergeLibraries,
    normalizeTraktRatings,
    annotateRatings,
  } = require('./services/library');
  const { buildRecommendations } = require('./services/recommender');

  const parts = [];
  let traktRatings = new Map();

  // Stremio library — isolated so a failure degrades to Trakt-only
  let stremioPromise = null;
  if (install.stremioAuthKeyEnc) {
    stremioPromise = (async () => {
      const authKey = decrypt(install.stremioAuthKeyEnc);
      const raw = await fetchLibrary(authKey);
      return normalizeStremioLibrary(raw);
    })();
  }

  // Trakt data — use allSettled for per-type degradation
  let traktMoviesWatchedPromise = null;
  let traktShowsWatchedPromise = null;
  let traktMoviesRatedPromise = null;
  let traktShowsRatedPromise = null;

  if (install.traktAccessTokenEnc) {
    const token = decrypt(install.traktAccessTokenEnc);
    traktMoviesWatchedPromise = fetchWatchedMovies(token);
    traktShowsWatchedPromise = fetchWatchedShows(token);
    traktMoviesRatedPromise = fetchRatedMovies(token);
    traktShowsRatedPromise = fetchRatedShows(token);
  }

  // Await all with allSettled
  const promises = [
    stremioPromise || Promise.resolve(null),
    traktMoviesWatchedPromise || Promise.resolve(null),
    traktShowsWatchedPromise || Promise.resolve(null),
    traktMoviesRatedPromise || Promise.resolve(null),
    traktShowsRatedPromise || Promise.resolve(null),
  ];

  const results = await Promise.allSettled(promises);

  // Process results with per-type degradation
  const stremioResult = results[0];
  const moviesWatchedResult = results[1];
  const showsWatchedResult = results[2];
  const moviesRatedResult = results[3];
  const showsRatedResult = results[4];

  if (stremioResult.status === 'fulfilled' && stremioResult.value) {
    parts.push(stremioResult.value);
  } else if (stremioResult.status === 'rejected') {
    console.warn('[pipeline] Stremio library fetch failed, continuing with other sources:', stremioResult.reason?.message);
  }

  const moviesWatchedOk = moviesWatchedResult.status === 'fulfilled' && moviesWatchedResult.value != null;
  const showsWatchedOk = showsWatchedResult.status === 'fulfilled' && showsWatchedResult.value != null;

  // Combine Trakt watched data
  const traktWatched = [];
  if (moviesWatchedOk) {
    traktWatched.push(...normalizeTraktMovies(moviesWatchedResult.value));
  } else if (moviesWatchedResult.status === 'rejected') {
    console.warn('[pipeline] Trakt movies watched failed:', moviesWatchedResult.reason?.message);
  }
  if (showsWatchedOk) {
    traktWatched.push(...normalizeTraktShows(showsWatchedResult.value));
  } else if (showsWatchedResult.status === 'rejected') {
    console.warn('[pipeline] Trakt shows watched failed:', showsWatchedResult.reason?.message);
  }

  if (traktWatched.length > 0) {
    parts.push(traktWatched);
  }

  // Process ratings with per-type degradation
  // If movies watched failed → discard movie ratings
  // If shows watched failed → discard show ratings
  const ratedMovies = (moviesWatchedOk && moviesRatedResult.status === 'fulfilled')
    ? (moviesRatedResult.value || [])
    : [];
  const ratedShows = (showsWatchedOk && showsRatedResult.status === 'fulfilled')
    ? (showsRatedResult.value || [])
    : [];

  if (ratedMovies.length > 0 || ratedShows.length > 0) {
    traktRatings = normalizeTraktRatings(ratedMovies, ratedShows);
  }

  // Merge all library parts
  let merged = [];
  for (const p of parts) {
    merged = mergeLibraries(merged, p);
  }

  // Annotate with ratings
  const { mergedItems, profileOnlyItems } = annotateRatings(merged, traktRatings);

  const result = await buildRecommendations(mergedItems, type, { profileOnlyItems, resolveTarget });
  return { candidates: result.candidates, buildOk: !result.hadSourceFailures };
}

// ---------------------------------------------------------------------------
// Helper: checkFreshness
// ---------------------------------------------------------------------------

async function checkFreshness(install, cached, db, decrypt, type) {
  let changed = false;
  let stremioInvalid = false;
  const prev = cached.libraryFreshness ? JSON.parse(cached.libraryFreshness) : {};

  // Stremio probe
  if (install.stremioAuthKeyEnc) {
    const { fetchLibraryMeta, validateKey } = require('./auth/stremio');
    const authKey = decrypt(install.stremioAuthKeyEnc);
    try {
      const meta = await fetchLibraryMeta(authKey);
      // datastoreMeta returns array of {_id, mtime} entries; extract max mtime
      const maxMtime = extractMaxMtime(meta);
      if (maxMtime && maxMtime !== prev.stremioMaxMtime) {
        changed = true;
      }
    } catch (_) {
      // Probe failed — distinguish expired key from transient network error.
      // validateKey is a lightweight call that returns boolean.
      try {
        const valid = await validateKey(authKey);
        if (!valid) {
          console.warn('[freshness] Stremio auth key invalid, will degrade');
          stremioInvalid = true;
          changed = true;
        }
      } catch (_e) { /* network error — treat as transient, do not degrade */ }
    }
  }

  // Trakt probe
  if (install.traktAccessTokenEnc) {
    const { fetchRecentHistory } = require('./auth/trakt');
    const token = decrypt(install.traktAccessTokenEnc);
    try {
      // Trakt history endpoint expects "movies" or "shows"
      const traktType = (type === 'series') ? 'shows' : 'movies';
      const recent = await fetchRecentHistory(token, traktType);
      if (recent && recent.watched_at) {
        const prevKey = traktType === 'shows'
          ? 'traktShowsLastWatchedAt'
          : 'traktMoviesLastWatchedAt';
        if (recent.watched_at !== prev[prevKey]) {
          changed = true;
        }
      }
    } catch (_) { /* ignore transient probe failures */ }
  }

  // Only update checkedAt when nothing changed, so we skip probing for 15 min.
  // When a change IS detected, leave the old checkedAt so that if the subsequent
  // rebuild fails, the next request will probe again immediately instead of
  // being suppressed for 15 minutes by a stale checkedAt.
  if (!changed) {
    db.setFreshness(install.id, type, prev);
  }

  return { changed, stremioInvalid };
}

// ---------------------------------------------------------------------------
// Helper: captureFreshness
// ---------------------------------------------------------------------------

async function captureFreshness(install, decrypt) {
  const result = {
    stremioMaxMtime: null,
    traktMoviesLastWatchedAt: null,
    traktShowsLastWatchedAt: null,
    checkedAt: Math.floor(Date.now() / 1000)
  };

  if (install.stremioAuthKeyEnc) {
    const { fetchLibraryMeta } = require('./auth/stremio');
    const authKey = decrypt(install.stremioAuthKeyEnc);
    try {
      const meta = await fetchLibraryMeta(authKey);
      const maxMtime = extractMaxMtime(meta);
      if (maxMtime) result.stremioMaxMtime = maxMtime;
    } catch (_) { /* best effort */ }
  }

  if (install.traktAccessTokenEnc) {
    const { fetchRecentHistory } = require('./auth/trakt');
    const token = decrypt(install.traktAccessTokenEnc);
    try {
      const movieRecent = await fetchRecentHistory(token, 'movies');
      if (movieRecent && movieRecent.watched_at) {
        result.traktMoviesLastWatchedAt = movieRecent.watched_at;
      }
    } catch (_) { /* best effort */ }
    try {
      const showRecent = await fetchRecentHistory(token, 'shows');
      if (showRecent && showRecent.watched_at) {
        result.traktShowsLastWatchedAt = showRecent.watched_at;
      }
    } catch (_) { /* best effort */ }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Helper: enrichPage
// ---------------------------------------------------------------------------

async function enrichPage(candidates, type) {
  const { getMeta } = require('./services/cinemeta');

  const raw = await Promise.all(candidates.map(async (candidate) => {
    let meta = null;
    try {
      meta = await getMeta(type, candidate.imdbId);
    } catch (_) { /* fall back to TMDB data */ }

    const poster = (meta && meta.poster) || posterUrl(candidate.poster_path);

    return {
      id: candidate.imdbId,
      type: type,
      name: (meta && meta.name) || candidate.name || '',
      poster: poster || '',
      posterShape: 'poster',
      description: (meta && meta.description) || '',
      releaseInfo: (meta && meta.releaseInfo) ||
        (candidate.release_date || '').substring(0, 4),
      imdbRating: (meta && meta.imdbRating) ||
        String(candidate.vote_average || ''),
      genres: (meta && meta.genres) || []
    };
  }));

  // Safety net: drop any items that still lack a poster after enrichment
  // (pre-filter on poster_path before pagination handles the main case)
  return raw.filter(m => m.poster);
}

// ---------------------------------------------------------------------------
// Catalog Handler
// ---------------------------------------------------------------------------

builder.defineCatalogHandler(async (args) => {
  const installId = args.config && args.config.installId;
  if (!installId) return { metas: [] };

  const db = require('./db');
  const { decrypt } = require('./utils/crypto');
  const { refreshIfNeeded } = require('./auth/trakt');
  const { recBuildLock } = require('./utils/buildLock');

  const type = args.type; // "movie" or "series"
  const skip = parseInt(args.extra && args.extra.skip, 10) || 0;
  const genre = args.extra && args.extra.genre;
  const PAGE_SIZE = 100;
  const MAX_DEPTH = 1200;
  if (skip >= MAX_DEPTH) return { metas: [] };
  const requiredDepth = Math.min(Math.max(500, skip + PAGE_SIZE + 200), MAX_DEPTH);
  const requiredTier = requiredDepth <= 500 ? 1 : requiredDepth <= 1000 ? 2 : 3;

  try {
    // 1. Lookup install
    let install = db.getInstall(installId);
    if (!install) return { metas: [] };

    // 2. Refresh Trakt token if needed (use the returned install so
    //    the rest of this request sees the fresh tokens).
    //    If refresh fails, null out Trakt fields on the in-memory install
    //    so the pipeline degrades to Stremio-only instead of aborting.
    let sourceDegraded = false;
    if (install.traktAccessTokenEnc) {
      try {
        install = await refreshIfNeeded(install, {
          getInstall: db.getInstall,
          updateInstall: db.updateInstall,
          encrypt: require('./utils/crypto').encrypt,
          decrypt
        });
      } catch (err) {
        console.warn('[catalog] Trakt token refresh failed, degrading to other sources:', err.message);
        install = { ...install, traktAccessTokenEnc: null, traktRefreshTokenEnc: null };
        sourceDegraded = true;
      }
    }

    // 3. Check recommendation cache
    let cached = db.getCachedRecs(installId, type);
    let candidates;
    let needsRebuild = sourceDegraded; // force rebuild if a source is gone

    if (cached) {
      // Check freshness (source-specific probes, at most every 15 min per type)
      const freshness = db.getFreshness(installId, type);
      const fifteenMinAgo = Math.floor(Date.now() / 1000) - 900;

      if (!freshness || freshness.checkedAt < fifteenMinAgo) {
        const probe = await checkFreshness(install, cached, db, decrypt, type);
        if (probe.changed) needsRebuild = true;
        if (probe.stremioInvalid) {
          install = { ...install, stremioAuthKeyEnc: null };
          sourceDegraded = true;
          needsRebuild = true;
        }
      }

      // Check TTL (6 hours)
      const sixHoursAgo = Math.floor(Date.now() / 1000) - 21600;
      if (cached.computedAt < sixHoursAgo) needsRebuild = true;

      if (!needsRebuild) {
        // Check depth and tier adequacy
        const depthOk = cached.buildDepth >= requiredDepth;
        const sameTierClean = cached.buildBudget >= requiredTier && cached.buildOk;
        if (depthOk || sameTierClean) {
          candidates = JSON.parse(cached.rankedJson);
        } else {
          needsRebuild = true;
        }
      }
    } else {
      needsRebuild = true;
    }

    // 4. Full pipeline (on cache miss)
    if (needsRebuild) {
      const lockResult = await recBuildLock.acquireOrWait(`${installId}:${type}`);
      if (lockResult.isOwner) {
        try {
          const result = await runPipeline(install, type, db, decrypt, requiredDepth);
          candidates = result.candidates;
          const freshnessData = await captureFreshness(install, decrypt);
          db.setCachedRecs(
            installId,
            type,
            JSON.stringify(candidates),
            JSON.stringify(freshnessData),
            candidates.length,
            requiredTier,
            result.buildOk ? 1 : 0
          );
          db.setFreshness(installId, type, freshnessData);
          lockResult.release(candidates);
        } catch (err) {
          lockResult.release(null);
          throw err;
        }
      } else {
        candidates = await lockResult.promise;
        if (!candidates) return { metas: [] };
        // Check if the build that just finished is adequate for our depth
        const after = db.getCachedRecs(installId, type);
        const afterOk = after && (after.buildDepth >= requiredDepth
          || (after.buildBudget >= requiredTier && after.buildOk));
        if (!afterOk) {
          // Need a deeper build
          const deep = await recBuildLock.acquireOrWait(`${installId}:${type}`);
          if (deep.isOwner) {
            try {
              // Re-check cache (another waiter may have rebuilt)
              const re = db.getCachedRecs(installId, type);
              const staleThreshold = Math.floor(Date.now() / 1000) - 21600;
              if (re && re.computedAt > staleThreshold
                  && (re.buildDepth >= requiredDepth || (re.buildBudget >= requiredTier && re.buildOk))) {
                candidates = JSON.parse(re.rankedJson);
              } else {
                const result = await runPipeline(install, type, db, decrypt, requiredDepth);
                candidates = result.candidates;
                const freshnessData = await captureFreshness(install, decrypt);
                db.setCachedRecs(
                  installId,
                  type,
                  JSON.stringify(candidates),
                  JSON.stringify(freshnessData),
                  candidates.length,
                  requiredTier,
                  result.buildOk ? 1 : 0
                );
                db.setFreshness(installId, type, freshnessData);
              }
              deep.release(candidates);
            } catch (err) {
              deep.release(null);
              throw err;
            }
          } else {
            candidates = await deep.promise;
            if (!candidates) return { metas: [] };
          }
        }
      }
    }

    // 5. Pre-filter: drop candidates that have no poster at the raw level
    //    so pagination counts are stable (no short pages).
    candidates = candidates.filter(c => c.poster_path);

    // 6. Apply genre filter
    if (genre) {
      candidates = candidates.filter(function (c) {
        return c.genre_ids && c.genre_ids.some(function (gid) {
          return genreNameMatches(gid, genre);
        });
      });
    }

    // 7. Paginate
    const page = candidates.slice(skip, skip + PAGE_SIZE);

    // 8. Enrich this page via Cinemeta
    const metas = await enrichPage(page, type);

    return { metas, cacheMaxAge: 21600, staleRevalidate: 3600 };
  } catch (err) {
    console.error(`Catalog handler error for ${installId}:`, err.message);
    return { metas: [] };
  }
});

// ---------------------------------------------------------------------------
// Install URL helper
// ---------------------------------------------------------------------------

function stremioInstallUrl(baseUrl, installId) {
  const host = baseUrl.replace(/^https?:\/\//, '');
  const configJson = JSON.stringify({ installId });
  const encoded = encodeURIComponent(configJson);
  return `stremio://${host}/${encoded}/manifest.json`;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = builder;
module.exports.stremioInstallUrl = stremioInstallUrl;
