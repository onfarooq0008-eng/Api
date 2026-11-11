'use strict';

/** Fixed-window rate limiter keyed by an arbitrary string (client IP). */
function createLimiter({ windowMs, max }) {
  const buckets = new Map(); // key -> { count, resetAt }

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
  }, Math.max(windowMs, 10_000));
  sweep.unref();

  return {
    /** @returns {{ok:boolean, limit:number, remaining:number, resetSec:number}} */
    hit(key) {
      const now = Date.now();
      let b = buckets.get(key);
      if (!b || b.resetAt <= now) {
        b = { count: 0, resetAt: now + windowMs };
        buckets.set(key, b);
      }
      b.count++;
      return {
        ok: b.count <= max,
        limit: max,
        remaining: Math.max(0, max - b.count),
        resetSec: Math.max(1, Math.ceil((b.resetAt - now) / 1000)),
      };
    },
    stop() {
      clearInterval(sweep);
    },
  };
}

module.exports = { createLimiter };
