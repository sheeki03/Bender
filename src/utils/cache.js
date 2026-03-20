'use strict';

const CLEANUP_INTERVAL_MS = 60_000;

class Cache {
  constructor(name) {
    this._name = name;
    this._store = new Map();

    this._cleanupTimer = setInterval(() => this._sweep(), CLEANUP_INTERVAL_MS);
    this._cleanupTimer.unref();
  }

  get(key) {
    const entry = this._store.get(key);
    if (!entry) return undefined;

    if (Date.now() > entry.expiresAt) {
      this._store.delete(key);
      return undefined;
    }

    return entry.value;
  }

  set(key, value, ttlMs) {
    this._store.set(key, {
      value,
      expiresAt: Date.now() + ttlMs,
    });
  }

  has(key) {
    const entry = this._store.get(key);
    if (!entry) return false;

    if (Date.now() > entry.expiresAt) {
      this._store.delete(key);
      return false;
    }

    return true;
  }

  del(key) {
    this._store.delete(key);
  }

  clear() {
    this._store.clear();
  }

  size() {
    return this._store.size;
  }

  _sweep() {
    const now = Date.now();
    for (const [key, entry] of this._store) {
      if (now > entry.expiresAt) {
        this._store.delete(key);
      }
    }
  }
}

const cinemetaCache = new Cache('cinemeta');   // 24hr default TTL
const tmdbCache = new Cache('tmdb');           // 24hr default TTL
const tmdbIdCache = new Cache('tmdb-id');      // 7 day default TTL

module.exports = { Cache, cinemetaCache, tmdbCache, tmdbIdCache };
