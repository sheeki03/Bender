'use strict';

const INITIAL_MIN_DELAY_MS = 25;
const RESET_WINDOW_MS = 60_000;
const DEFAULT_BACKOFF_SEC = 2;

class AdaptiveRateLimiter {
  constructor() {
    this._queue = [];
    this._paused = false;
    this._minDelay = 0;
    this._lastBackoffAt = 0;
    this._processing = false;

    // Reset adaptive delay after 60s of no 429s
    this._resetTimer = setInterval(() => {
      if (this._minDelay > 0 && Date.now() - this._lastBackoffAt >= RESET_WINDOW_MS) {
        this._minDelay = 0;
      }
    }, RESET_WINDOW_MS);
    this._resetTimer.unref();
  }

  acquire() {
    return new Promise((resolve) => {
      this._queue.push(resolve);
      this._process();
    });
  }

  backoff(retryAfterSec) {
    const pauseMs = (retryAfterSec || DEFAULT_BACKOFF_SEC) * 1000;
    this._lastBackoffAt = Date.now();

    // Exponentially increase minimum delay between requests
    if (this._minDelay === 0) {
      this._minDelay = INITIAL_MIN_DELAY_MS;
    } else {
      this._minDelay = this._minDelay * 2;
    }

    this._paused = true;

    setTimeout(() => {
      this._paused = false;
      this._process();
    }, pauseMs);
  }

  async _process() {
    if (this._processing || this._paused || this._queue.length === 0) return;

    this._processing = true;

    while (this._queue.length > 0 && !this._paused) {
      const resolve = this._queue.shift();
      resolve();

      if (this._minDelay > 0 && this._queue.length > 0) {
        await new Promise((r) => setTimeout(r, this._minDelay));
      }
    }

    this._processing = false;
  }
}

const tmdbLimiter = new AdaptiveRateLimiter();

module.exports = { AdaptiveRateLimiter, tmdbLimiter };
