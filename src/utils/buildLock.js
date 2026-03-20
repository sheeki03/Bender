'use strict';

/**
 * Single-flight lock for expensive async operations.
 *
 * When multiple callers request the same key concurrently, only the first
 * (the "owner") executes the operation. Subsequent callers ("waiters")
 * receive the owner's result via a shared promise. A safety timeout
 * rejects waiters and clears the lock if the owner never releases.
 */

const SAFETY_TIMEOUT_MS = 120_000;

class BuildLock {
  constructor() {
    this._locks = new Map();
  }

  async acquireOrWait(key) {
    const existing = this._locks.get(key);

    if (existing) {
      return { isOwner: false, promise: existing.promise };
    }

    let resolveWaiters;
    let rejectWaiters;

    const promise = new Promise((resolve, reject) => {
      resolveWaiters = resolve;
      rejectWaiters = reject;
    });

    const timeoutId = setTimeout(() => {
      rejectWaiters(new Error(`BuildLock timeout: key "${key}" was not released within ${SAFETY_TIMEOUT_MS / 1000}s`));
      this._locks.delete(key);
    }, SAFETY_TIMEOUT_MS);

    if (timeoutId.unref) {
      timeoutId.unref();
    }

    const release = (result) => {
      clearTimeout(timeoutId);
      this._locks.delete(key);
      resolveWaiters(result);
    };

    this._locks.set(key, { promise });

    return { isOwner: true, release };
  }
}

const recBuildLock = new BuildLock();

module.exports = { BuildLock, recBuildLock };
