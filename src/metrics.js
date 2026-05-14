'use strict';

/**
 * Per-tenant metering counters.
 * Tracks queries, bytes, latency for billing/monitoring.
 */
class Metrics {
  constructor() {
    this.queries_total    = 0;   // successful queries
    this.queries_rejected = 0;   // rejected by rate limiter
    this.bytes_sent       = 0;   // bytes of SQL sent to backend
    this.bytes_received   = 0;   // bytes of results received
    this.cpu_ms           = 0;   // total wall-clock query time (ms)
  }

  recordSuccess(sql, result_bytes, elapsed_ms) {
    this.queries_total++;
    this.bytes_sent     += Buffer.byteLength(sql, 'utf8');
    this.bytes_received += result_bytes;
    this.cpu_ms         += elapsed_ms;
  }

  recordRejection() {
    this.queries_rejected++;
  }

  snapshot() {
    return {
      queries_total:    this.queries_total,
      queries_rejected: this.queries_rejected,
      bytes_sent:       this.bytes_sent,
      bytes_received:   this.bytes_received,
      cpu_ms:           Math.round(this.cpu_ms),
    };
  }
}

module.exports = { Metrics };
