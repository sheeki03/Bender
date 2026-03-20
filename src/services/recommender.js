'use strict';

const { mergeLibraries, normalizeStremioLibrary, normalizeTraktMovies, normalizeTraktShows, getMaxLastWatched } = require('./library');
const { getMeta, enrichMetas } = require('./cinemeta');
const { findByImdbId, getRecommendationsPaged, getSimilarPaged, getExternalIds, discoverPaged, getTrendingPaged, posterUrl, mapType } = require('./tmdb');

const DEBUG = !!process.env.RECOMMENDER_DEBUG;

// ---------------------------------------------------------------------------
// Concurrency helper
// ---------------------------------------------------------------------------

async function batchResolve(items, batchSize, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.allSettled(batch.map(fn));
    results.push(...batchResults.filter(r => r.status === 'fulfilled').map(r => r.value));
  }
  return results;
}

// ---------------------------------------------------------------------------
// Name normalization for franchise dedup
// ---------------------------------------------------------------------------

/**
 * Strip trailing numbers, roman numerals, colons, subtitles, and common
 * sequel markers to produce a franchise "prefix" for dedup.
 *
 * Examples:
 *   "Iron Man 3"           → "iron man"
 *   "The Godfather: Part II" → "the godfather"
 *   "Alien: Covenant"      → "alien"
 *   "Fast & Furious 9"     → "fast & furious"
 */
function franchisePrefix(name) {
  if (!name) return '';
  let n = name.toLowerCase().trim();
  // Strip trailing " - Subtitle" or ": Subtitle"
  n = n.replace(/\s*[-:]\s+.*$/, '');
  // Strip trailing roman numerals (I, II, III, IV, V, VI, VII, VIII, IX, X, etc.)
  n = n.replace(/\s+(x{0,3})(ix|iv|v?i{0,3})$/i, '');
  // Strip trailing "Part N" / "Part II" etc.
  n = n.replace(/\s+part\s+\w+$/i, '');
  // Strip trailing plain numbers
  n = n.replace(/\s+\d+$/, '');
  return n.trim();
}

// ---------------------------------------------------------------------------
// Step 10a: Engagement Scoring
// ---------------------------------------------------------------------------

/**
 * Score a library item's engagement based on type.
 *
 * @param {object} item - A normalized library item (from mergeLibraries).
 * @param {string} type - "movie" or "series".
 * @returns {number} Engagement score in [0, 1].
 */
function scoreEngagement(item, type) {
  const eng = item.engagement || {};
  const timesWatched = eng.timesWatched || 0;
  const overallTimeWatched = eng.overallTimeWatched || 0;
  const duration = eng.duration || 0;
  const flaggedWatched = eng.flaggedWatched || 0;
  const lastWatched = eng.lastWatched;

  const daysSinceLastWatched = lastWatched
    ? Math.max(0, (Date.now() - new Date(lastWatched).getTime()) / (1000 * 60 * 60 * 24))
    : 365;
  const recencyScore = 1 / (1 + daysSinceLastWatched / 90);

  let score;

  // Trakt-only: no duration/progress data
  if (overallTimeWatched === 0 && duration === 0) {
    score = (timesWatched > 0 ? 0.4 : 0)
      + (Math.min(Math.log2(timesWatched + 1) / 5, 1.0) * 0.35)
      + (recencyScore * 0.25);
  } else if (type === 'movie') {
    const completionRate = duration > 0 ? Math.min(overallTimeWatched / duration, 1.0) : 0;
    const skipSignal = eng.skipSignal || 0;
    let rawScore = (completionRate * 0.4)
      + (Math.min(Math.log2(timesWatched + 1) / 3, 1.0) * 0.25)
      + (recencyScore * 0.2)
      + (flaggedWatched > 0 ? 0.15 : 0);
    rawScore *= (1.0 - skipSignal * 0.6);
    score = rawScore;
  } else {
    // Series
    const hasWatched = timesWatched > 0
      || flaggedWatched > 0
      || (duration > 0 && overallTimeWatched > duration * 0.7);
    score = (hasWatched ? 0.3 : 0)
      + (Math.min(Math.log2(timesWatched + 1) / 7, 1.0) * 0.30)
      + (recencyScore * 0.30)
      + (flaggedWatched > 0 ? 0.10 : 0);
  }

  // Trakt rating boost (all branches)
  const traktRating = eng.traktRating;
  if (traktRating != null) {
    score = Math.max(0, Math.min(1, score + traktRating * 0.25));
  }

  return score;
}

// ---------------------------------------------------------------------------
// Profile weight for ratings-only items
// ---------------------------------------------------------------------------

function profileWeight(item) {
  const eng = item.engagement || {};
  const rating = eng.traktRating;
  if (rating == null || rating <= 0) return 0;
  const ratedAt = eng.ratedAt;
  const daysSinceRatedAt = ratedAt
    ? Math.max(0, (Date.now() - new Date(ratedAt).getTime()) / (1000 * 60 * 60 * 24))
    : 365;
  const recency = Math.pow(0.5, daysSinceRatedAt / 180);
  return rating * recency * 0.5;
}

// ---------------------------------------------------------------------------
// Step 10b: User Profile
// ---------------------------------------------------------------------------

/**
 * Build genre affinity, genre combo affinity, and year distribution from seeds.
 *
 * @param {object[]} seeds - Enriched seed items with meta (genres, releaseInfo).
 * @param {string}   type  - "movie" or "series".
 * @param {object[]} profileOnlySeeds - Items with only ratings (no watch data).
 * @returns {object} Profile object.
 */
function buildProfile(seeds, type, profileOnlySeeds = []) {
  const genreRaw = {};
  const genreComboRaw = {};
  const genreComboSupport = {}; // number of seeds supporting each combo
  let yearWeightedSum = 0;
  let yearWeightTotal = 0;
  let yearSqSum = 0;

  for (const seed of seeds) {
    const engagement = seed._engagement || 0;
    const genres = (seed.meta && seed.meta.genres) || [];
    const skipSignal = (seed.engagement && seed.engagement.skipSignal) || 0;
    const traktRating = (seed.engagement && seed.engagement.traktRating);

    // Recency weighting (watched seeds only)
    const lastWatched = seed.engagement && seed.engagement.lastWatched;
    const daysSince = lastWatched
      ? Math.max(0, (Date.now() - new Date(lastWatched).getTime()) / (1000 * 60 * 60 * 24))
      : 365;
    const recencyWeight = Math.pow(0.5, daysSince / 180);

    let weight = engagement * recencyWeight;
    // Skip signal dampens genre contribution
    weight *= (1 - skipSignal * 0.5);
    // Trakt rating boosts seed weight
    if (traktRating != null) {
      weight *= (1 + traktRating * 0.3);
    }

    for (const genre of genres) {
      const g = typeof genre === 'string' ? genre : String(genre);
      genreRaw[g] = (genreRaw[g] || 0) + weight;
    }

    // Genre combo affinity (sorted pairs)
    const sortedGenres = genres.map(g => typeof g === 'string' ? g : String(g)).sort();
    for (let i = 0; i < sortedGenres.length; i++) {
      for (let j = i + 1; j < sortedGenres.length; j++) {
        const combo = `${sortedGenres[i]}|${sortedGenres[j]}`;
        genreComboRaw[combo] = (genreComboRaw[combo] || 0) + weight;
        genreComboSupport[combo] = (genreComboSupport[combo] || 0) + 1;
      }
    }

    // Year affinity (continuous)
    const year = parseYear(seed.meta && seed.meta.releaseInfo);
    if (year) {
      yearWeightedSum += year * weight;
      yearSqSum += year * year * weight;
      yearWeightTotal += weight;
    }
  }

  // Profile-only seeds (already decayed via profileWeight)
  for (const seed of profileOnlySeeds) {
    const pw = seed._profileWeight || 0;
    if (pw <= 0) continue;
    const genres = (seed.meta && seed.meta.genres) || [];

    for (const genre of genres) {
      const g = typeof genre === 'string' ? genre : String(genre);
      genreRaw[g] = (genreRaw[g] || 0) + pw;
    }

    const sortedGenres = genres.map(g => typeof g === 'string' ? g : String(g)).sort();
    for (let i = 0; i < sortedGenres.length; i++) {
      for (let j = i + 1; j < sortedGenres.length; j++) {
        const combo = `${sortedGenres[i]}|${sortedGenres[j]}`;
        genreComboRaw[combo] = (genreComboRaw[combo] || 0) + pw;
        genreComboSupport[combo] = (genreComboSupport[combo] || 0) + 1;
      }
    }

    const year = parseYear(seed.meta && seed.meta.releaseInfo);
    if (year) {
      yearWeightedSum += year * pw;
      yearSqSum += year * year * pw;
      yearWeightTotal += pw;
    }
  }

  // Normalize genre affinity so max = 1.0
  const maxRaw = Math.max(...Object.values(genreRaw), 0);
  const genreAffinity = {};
  if (maxRaw > 0) {
    for (const [g, v] of Object.entries(genreRaw)) {
      genreAffinity[g] = v / maxRaw;
    }
  }

  // Genre combo affinity: support-based shrinkage blending toward the
  // average of the constituent single-genre affinities (not toward zero).
  const maxCombo = Math.max(...Object.values(genreComboRaw), 0);
  const genreComboAffinity = {};
  if (maxCombo > 0) {
    for (const [combo, v] of Object.entries(genreComboRaw)) {
      const support = genreComboSupport[combo] || 0;
      const alpha = Math.min(support / 3, 1.0);
      const normalizedCombo = v / maxCombo;
      const [g1, g2] = combo.split('|');
      const singleBaseline = ((genreAffinity[g1] || 0) + (genreAffinity[g2] || 0)) / 2;
      genreComboAffinity[combo] = alpha * normalizedCombo + (1 - alpha) * singleBaseline;
    }
  }

  // Year mean and sigma (continuous, no decade bucketing)
  // null yearMean when no year evidence → scoring returns neutral 0.5
  let yearMean = null;
  let yearSigma = 15;
  if (yearWeightTotal > 0) {
    yearMean = yearWeightedSum / yearWeightTotal;
    const rawVariance = (yearSqSum / yearWeightTotal) - (yearMean * yearMean);
    yearSigma = Math.max(Math.sqrt(Math.max(rawVariance, 0)), 5.0);
  }

  // Confidence
  const watchedSeedCount = seeds.length;
  const profileOnlyCount = profileOnlySeeds.filter(s => (s._profileWeight || 0) > 0).length;
  const effectiveCount = watchedSeedCount + profileOnlyCount * 0.3;
  const userConfidence = Math.min(effectiveCount / 8, 1.0);

  // Confidence blending (toward neutral 0.5)
  for (const g of Object.keys(genreAffinity)) {
    genreAffinity[g] = userConfidence * genreAffinity[g] + (1 - userConfidence) * 0.5;
  }
  if (yearMean != null) {
    yearSigma = userConfidence * yearSigma + (1 - userConfidence) * 15;
  }

  // Per-user calibration (narrowness)
  const affinityValues = Object.values(genreAffinity);
  const affinityStd = affinityValues.length > 1
    ? Math.sqrt(affinityValues.reduce((s, v) => s + (v - affinityValues.reduce((a, b) => a + b, 0) / affinityValues.length) ** 2, 0) / affinityValues.length)
    : 0;
  const narrowness = Math.min(affinityStd / 0.4, 1.0);

  return {
    genreAffinity,
    genreComboAffinity,
    yearMean,
    yearSigma,
    userConfidence,
    narrowness,
  };
}

/**
 * Parse a year from Cinemeta's releaseInfo field.
 * Handles "2019", "2019-2023", "2019–" etc.
 */
function parseYear(releaseInfo) {
  if (!releaseInfo) return null;
  const str = String(releaseInfo);
  const match = str.match(/(\d{4})/);
  return match ? parseInt(match[1], 10) : null;
}

// ---------------------------------------------------------------------------
// TMDB genre ID → name mapping (for affinity lookup)
// ---------------------------------------------------------------------------

// Standard TMDB genre IDs for movies and TV
const TMDB_GENRE_MAP = {
  28: 'Action', 12: 'Adventure', 16: 'Animation', 35: 'Comedy',
  80: 'Crime', 99: 'Documentary', 18: 'Drama', 10751: 'Family',
  14: 'Fantasy', 36: 'History', 27: 'Horror', 10402: 'Music',
  9648: 'Mystery', 10749: 'Romance', 878: 'Science Fiction', 53: 'Thriller',
  10752: 'War', 37: 'Western', 10770: 'TV Movie',
  10759: 'Action & Adventure', 10762: 'Kids', 10763: 'News',
  10764: 'Reality', 10765: 'Sci-Fi & Fantasy',
  10766: 'Soap', 10767: 'Talk', 10768: 'War & Politics',
};

/**
 * Map a TMDB genre_id to a genre name usable for affinity lookup.
 */
function tmdbGenreName(genreId) {
  return TMDB_GENRE_MAP[genreId] || String(genreId);
}

// ---------------------------------------------------------------------------
// Pre-resolution scoring
// ---------------------------------------------------------------------------

function preResolutionScore(candidate, profile) {
  const genreIds = candidate.genre_ids || [];
  let genreSum = 0;
  let genreCount = 0;
  for (const gid of genreIds) {
    const gname = tmdbGenreName(gid);
    const aff = profile.genreAffinity[gname];
    genreSum += aff != null ? aff : 0.5;
    genreCount++;
  }
  const genreMatch = genreCount > 0 ? genreSum / genreCount : 0.5;

  const candYear = parseYear(candidate.release_date);
  let yearMatch = 0.5;
  if (candYear && profile.yearMean != null) {
    yearMatch = Math.exp(-Math.pow(candYear - profile.yearMean, 2) / (2 * profile.yearSigma * profile.yearSigma));
  }

  const sourceWeights = { recommendation: 1.0, similar: 0.7, discover: 0.5, trending: 0.4 };
  const sourceWeight = sourceWeights[candidate._bestSource] || 0.5;

  return genreMatch * 0.4 + sourceWeight * 0.3 + yearMatch * 0.2 + Math.min((candidate.sourceCount || 1) / 3, 1.0) * 0.1;
}

// ---------------------------------------------------------------------------
// Item similarity for MMR diversity
// ---------------------------------------------------------------------------

function itemSimilarity(a, b) {
  // Genre Jaccard
  const aGenres = new Set((a.genre_ids || []).map(tmdbGenreName));
  const bGenres = new Set((b.genre_ids || []).map(tmdbGenreName));
  const intersection = [...aGenres].filter(g => bGenres.has(g)).length;
  const union = new Set([...aGenres, ...bGenres]).size;
  const genreJaccard = union > 0 ? intersection / union : 0;

  // Franchise match
  const franchiseMatch = (franchisePrefix(a.name) && franchisePrefix(a.name) === franchisePrefix(b.name)) ? 1 : 0;

  // Year proximity
  const aYear = parseYear(a.release_date);
  const bYear = parseYear(b.release_date);
  const yearProx = (aYear && bYear) ? Math.max(0, 1 - Math.abs(aYear - bYear) / 30) : 0.5;

  return genreJaccard * 0.4 + franchiseMatch * 0.35 + yearProx * 0.25;
}

// ---------------------------------------------------------------------------
// Step 10c–10g: buildRecommendations
// ---------------------------------------------------------------------------

/**
 * Build a ranked list of recommendation candidates from a user's library.
 *
 * @param {object[]} libraryItems - Normalized, merged library items.
 * @param {string}   type         - "movie" or "series".
 * @param {object}   opts         - Options: { profileOnlyItems, resolveTarget }.
 * @returns {Promise<{candidates: object[], hadSourceFailures: boolean}>}
 */
async function buildRecommendations(libraryItems, type, opts = {}) {
  const items = Array.isArray(libraryItems) ? libraryItems : [];
  const tmdbType = mapType(type);
  const profileOnlyItems = opts.profileOnlyItems || [];
  const resolveTarget = opts.resolveTarget || 300;

  // Pagination tiers
  const tier = resolveTarget <= 500 ? 1 : resolveTarget <= 1000 ? 2 : 3;
  const pagesPerSeed = tier;
  const discoverPages = tier + 1;
  const trendingPages = tier;

  // ---- Cold-start check ----
  const typed = items.filter(i => i.type === type);
  const positiveProfileOnly = (profileOnlyItems || []).filter(p => p.type === type && profileWeight(p) > 0);

  if (typed.length === 0 && positiveProfileOnly.length === 0) {
    return coldStart(tmdbType, trendingPages);
  }

  let hadSourceFailures = false;

  // ---- Step 10a: Score all items of this type ----
  const scored = typed.map(item => ({
    ...item,
    _engagement: scoreEngagement(item, type),
  }));
  scored.sort((a, b) => b._engagement - a._engagement);

  // ---- Franchise dedup in seeds ----
  const dedupedSeeds = franchiseDedup(scored, '_engagement');

  // ---- Top 10 seeds ----
  const seeds = dedupedSeeds.slice(0, 10);

  // ---- Profile-only items handling ----
  const profileOnlyTyped = positiveProfileOnly
    .map(item => ({ ...item, _profileWeight: profileWeight(item) }))
    .sort((a, b) => b._profileWeight - a._profileWeight)
    .slice(0, 30);

  // Aggregate weight cap for mixed users: scale proportionally so all
  // selected items stay in the profile with bounded total influence.
  if (seeds.length > 0 && profileOnlyTyped.length > 0) {
    const totalSeedWeight = seeds.reduce((s, seed) => s + (seed._engagement || 0), 0);
    const maxProfileWeight = totalSeedWeight * 0.4;
    const currentProfileWeight = profileOnlyTyped.reduce((s, p) => s + p._profileWeight, 0);
    if (currentProfileWeight > maxProfileWeight) {
      const scale = maxProfileWeight / currentProfileWeight;
      for (const p of profileOnlyTyped) {
        p._profileWeight *= scale;
      }
    }
  }

  // Enrich profile-only items via Cinemeta
  let enrichedProfileOnly = [];
  if (profileOnlyTyped.length > 0) {
    const profileIds = profileOnlyTyped.map(s => s.imdbId);
    const profileMetaMap = await enrichMetas(type, profileIds);
    enrichedProfileOnly = profileOnlyTyped.map(s => ({
      ...s,
      meta: profileMetaMap.get(s.imdbId) || null,
    }));
  }

  // ---- Enrich seeds via Cinemeta ----
  const seedIds = seeds.map(s => s.imdbId);
  const metaMap = await enrichMetas(type, seedIds);

  const enrichedSeeds = seeds.map(s => ({
    ...s,
    meta: metaMap.get(s.imdbId) || null,
  }));

  // ---- Step 10b: Build profile ----
  const profile = buildProfile(enrichedSeeds, type, enrichedProfileOnly);

  // ---- Build library set for filtering ----
  const librarySet = new Set(items.map(i => i.imdbId));

  // ---- Step 10c: Candidate Generation ----
  const candidateMap = new Map();

  // Ratings-only path: skip Phase 1 seed-based recs if no watched seeds
  if (seeds.length > 0) {
    // Phase 1: Primary — recommendations from each seed
    // findByImdbId throws on TMDB fetch failure, returns null on legitimate
    // no-match. Use allSettled so we can count rejections as source failures.
    let seedFetchFailures = 0;
    const seedTmdbEntries = [];
    for (let i = 0; i < enrichedSeeds.length; i += 10) {
      const batch = enrichedSeeds.slice(i, i + 10);
      const batchResults = await Promise.allSettled(batch.map(async (seed) => {
        const found = await findByImdbId(seed.imdbId);
        return found ? { seed, tmdbId: found.tmdbId, tmdbType: found.type } : null;
      }));
      for (const r of batchResults) {
        if (r.status === 'fulfilled') {
          if (r.value) seedTmdbEntries.push(r.value);
        } else {
          seedFetchFailures++;
        }
      }
    }

    if (seedFetchFailures > enrichedSeeds.length * 0.3) {
      hadSourceFailures = true;
    }

    const recResults = await Promise.allSettled(
      seedTmdbEntries.map(async (entry) => {
        try {
          const { items: recs, hadFailures } = await getRecommendationsPaged(entry.tmdbId, entry.tmdbType, pagesPerSeed);
          return { recs, hadFailures, source: 'recommendation' };
        } catch {
          return { recs: [], hadFailures: true, source: 'recommendation' };
        }
      })
    );

    for (const result of recResults) {
      if (result.status !== 'fulfilled') { hadSourceFailures = true; continue; }
      const { recs, hadFailures, source } = result.value;
      if (hadFailures) hadSourceFailures = true;
      for (const item of recs) {
        addCandidate(candidateMap, item, source, tmdbType);
      }
    }

    // Phase 2: Backfill if < 350 unique candidates
    if (candidateMap.size < 350) {
      const simResults = await Promise.allSettled(
        seedTmdbEntries.slice(0, 10).map(async (entry) => {
          try {
            const { items: sims, hadFailures } = await getSimilarPaged(entry.tmdbId, entry.tmdbType, pagesPerSeed);
            return { sims, hadFailures, source: 'similar' };
          } catch {
            return { sims: [], hadFailures: true, source: 'similar' };
          }
        })
      );

      for (const result of simResults) {
        if (result.status !== 'fulfilled') { hadSourceFailures = true; continue; }
        const { sims, hadFailures, source } = result.value;
        if (hadFailures) hadSourceFailures = true;
        for (const item of sims) {
          addCandidate(candidateMap, item, source, tmdbType);
        }
      }
    }
  }

  // Discover from top 3 genres (always runs for ratings-only path, backfill for watched path)
  if (candidateMap.size < 350 || seeds.length === 0) {
    const topGenres = Object.entries(profile.genreAffinity)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);

    const discoverResults = await Promise.allSettled(
      topGenres.map(async ([genreName]) => {
        try {
          const genreId = findTmdbGenreId(genreName);
          if (!genreId) return { items: [], hadFailures: false };
          const result = await discoverPaged(tmdbType, {
            with_genres: String(genreId),
          }, discoverPages);
          return result;
        } catch {
          return { items: [], hadFailures: true };
        }
      })
    );

    for (const result of discoverResults) {
      if (result.status !== 'fulfilled') { hadSourceFailures = true; continue; }
      const { items: discItems, hadFailures } = result.value;
      if (hadFailures) hadSourceFailures = true;
      for (const item of discItems) {
        addCandidate(candidateMap, item, 'discover', tmdbType);
      }
    }
  }

  // Trending mix: always for ratings-only users (no watched seeds),
  // or when confidence is low for watched users
  if (seeds.length === 0 || profile.userConfidence < 0.5) {
    const { items: trendItems, hadFailures } = await getTrendingPaged(tmdbType, trendingPages);
    if (hadFailures) hadSourceFailures = true;
    for (const item of trendItems) {
      addCandidate(candidateMap, item, 'trending', tmdbType);
    }
  }

  // ---- Step 10d: Lazy IMDb ID Resolution ----
  // Pre-resolution personalized scoring
  const candidates = Array.from(candidateMap.values());
  candidates.sort((a, b) => preResolutionScore(b, profile) - preResolutionScore(a, profile));

  const resolved = [];
  let resolutionAttempts = 0;
  let resolutionFailures = 0;

  for (let i = 0; i < candidates.length && resolved.length < resolveTarget; i += 10) {
    const batch = candidates.slice(i, i + 10);
    const batchResults = await Promise.allSettled(
      batch.map(async (c) => {
        if (c.imdbId) return c;
        resolutionAttempts++;
        try {
          const ext = await getExternalIds(c.tmdbId, tmdbType);
          if (ext === null) {
            // tmdbFetch failed (HTTP/network error) — count as source failure
            resolutionFailures++;
            return null;
          }
          if (ext.imdb_id) {
            c.imdbId = ext.imdb_id;
            return c;
          }
          // ext exists but no imdb_id — legitimate no-match, not a failure
        } catch {
          resolutionFailures++;
        }
        return null;
      })
    );

    for (const r of batchResults) {
      if (r.status === 'fulfilled' && r.value && r.value.imdbId) {
        resolved.push(r.value);
      }
    }
  }

  // Mark as degraded if a significant share of resolution attempts failed
  if (resolutionAttempts > 0 && resolutionFailures > resolutionAttempts * 0.3) {
    hadSourceFailures = true;
  }

  // ---- Step 10e: Candidate Scoring ----
  for (const c of resolved) {
    c.score = scoreCandidateItem(c, profile, DEBUG);
  }

  // ---- Step 10f: Filtering ----
  const filtered = resolved.filter(c => {
    if (librarySet.has(c.imdbId)) return false;
    if ((c.vote_count || 0) < 50) return false;
    if (!c.imdbId) return false;
    return true;
  });

  // Soft franchise penalty on candidates (seeds still use hard dedup)
  const penalized = franchiseSoftPenalty(filtered);

  // ---- Step 10g: Diversity Enforcement (MMR) ----
  const diverse = enforceDiversity(penalized);

  // Debug: log top 10
  if (DEBUG && diverse.length > 0) {
    console.log('[recommender] Top 10 candidates:');
    for (const c of diverse.slice(0, 10)) {
      console.log(`  ${c.name || c.imdbId}: score=${c.score?.toFixed(3)}`, c._breakdown || '');
    }
  }

  // Return cleaned candidate objects, dropping posterless entries so
  // build_depth reflects the real paginable catalog.
  const finalCandidates = diverse
    .filter(c => c.poster_path)
    .map(c => ({
      imdbId: c.imdbId,
      tmdbId: c.tmdbId,
      score: c.score,
      genre_ids: c.genre_ids || [],
      name: c.name || null,
      vote_average: c.vote_average || 0,
      vote_count: c.vote_count || 0,
      poster_path: c.poster_path,
      release_date: c.release_date || null,
    }));

  return { candidates: finalCandidates, hadSourceFailures };
}

// ---------------------------------------------------------------------------
// Candidate helpers
// ---------------------------------------------------------------------------

/**
 * Add a TMDB result item to the candidate map, tracking source info and
 * deduplicating by tmdbId.
 */
const SOURCE_RANK = { recommendation: 3, similar: 2, discover: 1 };

function addCandidate(map, item, source, tmdbType) {
  if (!item || !item.id) return;

  const existing = map.get(item.id);
  if (existing) {
    existing.sourceCount = (existing.sourceCount || 1) + 1;
    if (!existing.sources.includes(source)) {
      existing.sources.push(source);
    }
    // Upgrade _bestSource when a stronger source is encountered
    if ((SOURCE_RANK[source] || 0) > (SOURCE_RANK[existing._bestSource] || 0)) {
      existing._bestSource = source;
    }
    return;
  }

  map.set(item.id, {
    tmdbId: item.id,
    imdbId: null, // resolved lazily
    name: item.title || item.name || null,
    vote_average: item.vote_average || 0,
    vote_count: item.vote_count || 0,
    genre_ids: item.genre_ids || [],
    poster_path: item.poster_path || null,
    release_date: item.release_date || item.first_air_date || null,
    sourceCount: 1,
    sources: [source],
    _bestSource: source,
  });
}

/**
 * Score an individual candidate.
 */
function scoreCandidateItem(candidate, profile, debug = false) {
  const { genreAffinity, genreComboAffinity, yearMean, yearSigma, userConfidence, narrowness } = profile;

  // genreMatch: average of affinity values for candidate's genres
  const genreIds = candidate.genre_ids || [];
  let genreSum = 0;
  let genreCount = 0;
  for (const gid of genreIds) {
    const gname = tmdbGenreName(gid);
    const aff = genreAffinity[gname];
    if (aff != null) {
      genreSum += aff;
      genreCount++;
    } else {
      // Unseen genre → neutral 0.5
      genreSum += 0.5;
      genreCount++;
    }
  }
  const singleMatch = genreCount > 0 ? genreSum / genreCount : 0.5;

  // Genre combo affinity
  let genreMatch = singleMatch;
  if (genreComboAffinity && Object.keys(genreComboAffinity).length > 0) {
    const genreNames = genreIds.map(gid => tmdbGenreName(gid)).sort();
    let bestCombo = -1;
    for (let i = 0; i < genreNames.length; i++) {
      for (let j = i + 1; j < genreNames.length; j++) {
        const combo = `${genreNames[i]}|${genreNames[j]}`;
        if (genreComboAffinity[combo] != null && genreComboAffinity[combo] > bestCombo) {
          bestCombo = genreComboAffinity[combo];
        }
      }
    }
    if (bestCombo >= 0) {
      genreMatch = 0.6 * bestCombo + 0.4 * singleMatch;
    }
  }

  // sourceWeight based on best source
  const sourceWeights = { recommendation: 1.0, similar: 0.7, discover: 0.5, trending: 0.4 };
  const bestSource = candidate._bestSource || 'discover';
  const sourceWeight = sourceWeights[bestSource] || 0.5;

  // ratingScore
  const ratingScore = (candidate.vote_average || 0) / 10;

  // Year affinity (continuous Gaussian)
  // neutral 0.5 when candidate year is missing OR profile has no year evidence
  const candYear = parseYear(candidate.release_date);
  let yearMatch = 0.5;
  if (candYear && yearMean != null) {
    yearMatch = Math.exp(-Math.pow(candYear - yearMean, 2) / (2 * yearSigma * yearSigma));
  }

  // multiSourceBonus (rescaled)
  const multiSourceBonus = Math.min(Math.log2(candidate.sourceCount || 1) / Math.log2(5), 1.0);

  // Popularity prior
  const popularityPrior = Math.min(Math.log10(Math.max(candidate.vote_count || 1, 1)) / 4, 1.0);

  // Per-user calibrated weights
  const W_genre  = 0.35 + narrowness * 0.10;
  const W_source = 0.25 - narrowness * 0.10;
  const W_rating = 0.15;
  const W_year   = 0.10;
  const W_multi  = 0.10;
  const W_pop    = 0.05;

  let rawScore = (genreMatch * W_genre)
    + (sourceWeight * W_source)
    + (ratingScore * W_rating)
    + (yearMatch * W_year)
    + (multiSourceBonus * W_multi)
    + (popularityPrior * W_pop);

  // Confidence weighting
  const score = userConfidence * rawScore + (1 - userConfidence) * 0.5;

  if (debug) {
    candidate._breakdown = {
      genreMatch, sourceWeight, ratingScore, yearMatch,
      multiSourceBonus, popularityPrior, rawScore, score,
      W_genre, W_source, narrowness, userConfidence,
    };
  }

  return score;
}

/**
 * Franchise dedup: group by name prefix, keep highest-scored per group.
 */
function franchiseDedup(items, scoreKey) {
  const groups = new Map();
  for (const item of items) {
    const prefix = franchisePrefix(item.name);
    const key = prefix || item.imdbId || String(Math.random());
    const existing = groups.get(key);
    if (!existing || (item[scoreKey] || 0) > (existing[scoreKey] || 0)) {
      groups.set(key, item);
    }
  }
  return Array.from(groups.values());
}

/**
 * Soft franchise penalty: progressively penalize later entries from same franchise.
 */
function franchiseSoftPenalty(candidates) {
  // Sort by final score first so the strongest entry in each franchise
  // gets the lightest penalty (0.7^0 = 1.0).
  candidates.sort((a, b) => (b.score || 0) - (a.score || 0));
  const franchiseCounts = new Map();
  for (const c of candidates) {
    const prefix = franchisePrefix(c.name);
    if (!prefix) continue;
    const count = franchiseCounts.get(prefix) || 0;
    c.score *= Math.pow(0.7, count);
    franchiseCounts.set(prefix, count + 1);
  }
  // Re-sort after penalties
  candidates.sort((a, b) => (b.score || 0) - (a.score || 0));
  return candidates;
}

/**
 * Reverse-lookup TMDB genre ID from a genre name string.
 */
function findTmdbGenreId(genreName) {
  for (const [id, name] of Object.entries(TMDB_GENRE_MAP)) {
    if (name === genreName) {
      const num = Number(id);
      if (Number.isInteger(num)) return num;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Step 10g: Diversity Enforcement (MMR-based)
// ---------------------------------------------------------------------------

function enforceDiversity(candidates) {
  if (candidates.length === 0) return [];

  const result = [];
  const remaining = [...candidates];

  // Pick the best-scored item first
  remaining.sort((a, b) => (b.score || 0) - (a.score || 0));
  result.push(remaining.shift());

  while (remaining.length > 0) {
    let bestIdx = 0;
    let bestAdjusted = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const cand = remaining[i];
      let maxSim = 0;
      for (const selected of result) {
        const sim = itemSimilarity(cand, selected);
        if (sim > maxSim) maxSim = sim;
      }
      const adjusted = (cand.score || 0) * (1 - maxSim * 0.3);
      if (adjusted > bestAdjusted) {
        bestAdjusted = adjusted;
        bestIdx = i;
      }
    }

    result.push(remaining.splice(bestIdx, 1)[0]);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Step 10i: Cold-Start Fallback
// ---------------------------------------------------------------------------

async function coldStart(tmdbType, trendingPages = 1) {
  let hadSourceFailures = false;
  try {
    const { items: trending, hadFailures } = await getTrendingPaged(tmdbType, trendingPages);
    if (hadFailures) hadSourceFailures = true;
    if (!Array.isArray(trending) || trending.length === 0) {
      return { candidates: [], hadSourceFailures: hadSourceFailures || trending.length === 0 };
    }

    let resolutionFailures = 0;
    const resolved = await batchResolve(trending, 10, async (item) => {
      try {
        const ext = await getExternalIds(item.id, tmdbType);
        if (ext === null) {
          // tmdbFetch failed — count as source failure
          resolutionFailures++;
          return null;
        }
        if (ext.imdb_id) {
          return {
            imdbId: ext.imdb_id,
            tmdbId: item.id,
            score: (item.vote_average || 0) / 10,
            genre_ids: item.genre_ids || [],
            name: item.title || item.name || null,
            vote_average: item.vote_average || 0,
            poster_path: item.poster_path || null,
            release_date: item.release_date || item.first_air_date || null,
          };
        }
        // ext exists but no imdb_id — legitimate no-match
        return null;
      } catch {
        resolutionFailures++;
        return null;
      }
    });

    if (resolutionFailures > trending.length * 0.3) hadSourceFailures = true;

    // Filter posterless entries so build_depth reflects the real paginable catalog
    const candidates = resolved.filter(c => c && c.poster_path);
    return { candidates, hadSourceFailures };
  } catch {
    return { candidates: [], hadSourceFailures: true };
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  buildRecommendations,
  scoreEngagement,
  buildProfile,
  profileWeight,
};
