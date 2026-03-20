# Bender

A Stremio addon that delivers personalized movie and TV recommendations by analyzing your watch history from Stremio and Trakt.

## How It Works

Bender builds a taste profile from your watch history and generates recommendations using TMDB's catalog. It learns what you like — genres, genre combos, release years, engagement patterns — and continuously refines suggestions as your library grows.

### Features

- **Multi-source library** — Merges watch history from Stremio and Trakt, deduplicating by IMDb ID
- **Skip detection** — Identifies movies you abandoned early and deprioritizes similar content
- **Trakt ratings integration** — Incorporates your explicit ratings with per-type z-score normalization
- **Genre combo affinity** — Detects that you love Crime+Drama specifically, not just Crime or Drama alone
- **Continuous year modeling** — Gaussian year preference instead of rigid decade buckets
- **Confidence-aware scoring** — New users get broader recommendations that narrow as the profile strengthens
- **Deep pagination** — Tier-based TMDB fetching scales the candidate pool as users scroll deeper
- **MMR diversity** — Maximal Marginal Relevance prevents the feed from clustering around one genre or franchise
- **Soft franchise penalty** — Sequels appear with diminishing scores instead of being hard-deduplicated
- **Graceful degradation** — Each data source fails independently; a Trakt outage doesn't break Stremio-based recs
- **Cold-start support** — Users with no history get trending content; users with only ratings get personalized discover + trending

## Prerequisites

- Node.js >= 20
- [TMDB API key](https://developer.themoviedb.org/docs/getting-started)
- [Trakt API app](https://trakt.tv/oauth/applications) (client ID + secret)

## Setup

1. Clone the repo:
   ```bash
   git clone https://github.com/sheeki03/Bender.git
   cd Bender
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Create a `.env` file from the example:
   ```bash
   cp .env.example .env
   ```

4. Fill in your API keys:
   ```
   TMDB_API_KEY=your_tmdb_key
   TRAKT_CLIENT_ID=your_trakt_client_id
   TRAKT_CLIENT_SECRET=your_trakt_client_secret
   BASE_URL=http://localhost:7000
   PORT=7000
   ENCRYPTION_KEY=<64 hex chars>
   SESSION_SECRET=<random string>
   ```

   Generate an encryption key:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

5. Start the server:
   ```bash
   npm start
   ```

   For development with auto-reload:
   ```bash
   npm run dev
   ```

6. Open `http://localhost:7000/configure` to set up your install and add it to Stremio.

## Architecture

```
src/
├── addon.js              Stremio catalog handler, caching, pipeline orchestration
├── config.js             Environment validation
├── db.js                 SQLite with migrations (better-sqlite3)
├── auth/
│   ├── stremio.js        Stremio library fetch
│   └── trakt.js          Trakt OAuth, watch history, ratings
├── services/
│   ├── cinemeta.js       Metadata enrichment (posters, descriptions)
│   ├── library.js        Library normalization, merge, ratings processing
│   ├── recommender.js    Scoring, profiling, candidate generation, ranking
│   └── tmdb.js           TMDB API client with pagination
├── utils/
│   ├── buildLock.js      Prevents thundering herd on concurrent rebuilds
│   ├── cache.js          TTL cache
│   ├── crypto.js         AES-256-GCM for stored tokens
│   └── rateLimiter.js    TMDB rate limit handling
└── public/
    └── configure.html    Setup UI
```

### Pipeline Flow

1. **Authenticate** — Refresh Trakt tokens if expiring
2. **Check cache** — Serve from SQLite if fresh and deep enough
3. **Fetch libraries** — Stremio + Trakt watched + Trakt ratings (all in parallel via `allSettled`)
4. **Merge & annotate** — Deduplicate by IMDb ID, attach ratings, generate profile-only items
5. **Score engagement** — Per-item engagement score with skip signal and rating boost
6. **Build profile** — Genre affinity, genre combos, year distribution, confidence, narrowness
7. **Generate candidates** — TMDB recommendations, similar, discover, trending (tier-based pagination)
8. **Resolve & score** — IMDb ID resolution, personalized scoring, franchise penalty
9. **Diversify** — MMR-based reranking
10. **Cache & serve** — Store with depth/tier/buildOk metadata, paginate, enrich via Cinemeta

## Debug Mode

Set `RECOMMENDER_DEBUG=1` to log per-candidate score breakdowns for the top 10 results:

```bash
RECOMMENDER_DEBUG=1 npm start
```

## License

MIT

