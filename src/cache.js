'use strict';

/**
 * Small in-memory cache with TTL + max size (oldest evicted first) and
 * in-flight de-duplication: concurrent identical requests share ONE upstream call.
 * Only successful results are stored.
 */
class Cache {
  constructor({ ttlMs, maxEntries }) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.store = new Map(); // key -> { value, expires }
    this.inflight = new Map(); // key -> Promise
    this.hits = 0;
    this.misses = 0;
  }

  /** @returns {Promise<{value:any, hit:boolean}>} */
  async wrap(key, producer) {
    const now = Date.now();
    const entry = this.store.get(key);
    if (entry && entry.expires > now) {
      this.hits++;
      return { value: entry.value, hit: true };
    }
    if (entry) this.store.delete(key);

    this.misses++;
    let p = this.inflight.get(key);
    if (!p) {
      p = (async () => {
        try {
          const value = await producer();
          if (this.ttlMs > 0) {
            this.store.set(key, { value, expires: Date.now() + this.ttlMs });
            while (this.store.size > this.maxEntries) this.store.delete(this.store.keys().next().value);
          }
          return value;
        } finally {
          this.inflight.delete(key);
        }
      })();
      this.inflight.set(key, p);
    }
    return { value: await p, hit: false };
  }

  stats() {
    return { size: this.store.size, hits: this.hits, misses: this.misses };
  }
}

module.exports = { Cache };
