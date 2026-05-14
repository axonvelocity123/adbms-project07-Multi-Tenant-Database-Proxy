'use strict';

/**
 * Token Bucket Rate Limiter (per tenant).
 *
 * Each bucket has:
 *   - capacity: max tokens (= rate_limit_per_sec, allows bursting up to 1 second's worth)
 *   - refill_rate: tokens added per millisecond
 *   - current_tokens: floating point current token count
 *   - last_refill_time: timestamp of last refill (Date.now())
 *
 * Algorithm on each consume():
 *   1. elapsed = now - last_refill_time
 *   2. current_tokens = min(capacity, current_tokens + elapsed * refill_rate)
 *   3. last_refill_time = now
 *   4. if current_tokens >= 1: subtract 1, return { allowed: true }
 *      else: return { allowed: false, retry_ms: ceil((1 - current_tokens) / refill_rate) }
 */
class RateLimiter {
  constructor(rate_limit_per_sec) {
    this.capacity = rate_limit_per_sec;          // bucket capacity (tokens)
    this.refill_rate = rate_limit_per_sec / 1000; // tokens per ms
    this.current_tokens = rate_limit_per_sec;     // start full
    this.last_refill_time = Date.now();

    // Simple mutex via a queued promise chain (Node.js is single-threaded,
    // but async callbacks interleave, so we serialize access)
    this._lock = Promise.resolve();
  }

  /**
   * Try to consume one token.
   * Returns { allowed: true } or { allowed: false, retry_ms: N }
   */
  consume() {
    const now = Date.now();
    const elapsed = now - this.last_refill_time;

    // refill
    this.current_tokens = Math.min(
      this.capacity,
      this.current_tokens + elapsed * this.refill_rate
    );
    this.last_refill_time = now;

    if (this.current_tokens >= 1) {
      this.current_tokens -= 1;
      return { allowed: true };
    }

    // how long until we have 1 token?
    const needed = 1 - this.current_tokens;
    const retry_ms = Math.ceil(needed / this.refill_rate);
    return { allowed: false, retry_ms };
  }

  /** Current fill level as a fraction 0..1 */
  fillLevel() {
    return Math.min(1, this.current_tokens / this.capacity);
  }
}

module.exports = { RateLimiter };
