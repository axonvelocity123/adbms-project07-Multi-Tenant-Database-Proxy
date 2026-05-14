'use strict';

const { Client } = require('pg');

/**
 * Per-Tenant Connection Pool
 *
 * Each tenant gets its own pool. All connections in a pool have
 * search_path permanently set to the tenant's schema, so they can
 * never accidentally serve another tenant's data.
 *
 * Pool parameters (from tenants.conf):
 *   min_size    = 1  (always keep at least 1 connection warm)
 *   max_size    = tenant.max_connections
 *
 * Operations:
 *   acquire()   → returns a pg.Client (async, may wait if pool full)
 *   release(c)  → return connection; discard if broken
 *   close()     → drain the pool on shutdown
 */
class TenantPool {
  constructor(tenant, backendConfig) {
    this.tenant_id  = tenant.tenant_id;
    this.schema     = tenant.schema;
    this.min_size   = 1;
    this.max_size   = tenant.max_connections;
    this.backendCfg = backendConfig;

    this._idle    = [];   // idle pg.Client objects
    this._inUse   = 0;    // number of connections currently checked out
    this._waiters = [];   // callbacks waiting for a free connection
    this._closed  = false;
  }

  /** Total connections open (idle + in use) */
  get totalOpen() {
    return this._idle.length + this._inUse;
  }

  get idleCount() { return this._idle.length; }
  get inUseCount() { return this._inUse; }

  /**
   * Open and configure a new backend connection for this tenant.
   */
  async _openConnection() {
    const client = new Client(this.backendCfg);
    await client.connect();

    // Permanently bind this connection to the tenant's schema.
    // This is done ONCE at creation time and never changes.
    await client.query(`SET search_path = "${this.schema}", public`);

    // Detect unexpected disconnects
    client.on('error', () => {
      // Silently mark as broken; release() will discard it
      client._broken = true;
    });

    return client;
  }

  /**
   * Warm up the pool to min_size connections.
   */
  async warmUp() {
    const needed = this.min_size - this.totalOpen;
    for (let i = 0; i < needed; i++) {
      try {
        const conn = await this._openConnection();
        this._idle.push(conn);
      } catch (err) {
        console.error(
          `[pool:${this.tenant_id}] warmup connection failed: ${err.message}`
        );
      }
    }
  }

  /**
   * Acquire a connection from the pool.
   * If idle connections are available, return one immediately.
   * If below max_size, open a new one.
   * Otherwise, queue and wait.
   */
  acquire() {
    return new Promise((resolve, reject) => {
      if (this._closed) {
        return reject(new Error('pool is closed'));
      }

      const tryGet = () => {
        // prefer idle connections
        if (this._idle.length > 0) {
          const conn = this._idle.pop();
          if (conn._broken) {
            // discard broken connections and try again
            conn.end().catch(() => {});
            return tryGet();
          }
          this._inUse++;
          return resolve(conn);
        }

        // open a new connection if below max
        if (this.totalOpen < this.max_size) {
          this._inUse++; // reserve the slot before async open
          this._openConnection()
            .then(conn => resolve(conn))
            .catch(err => {
              this._inUse--;
              reject(err);
            });
          return;
        }

        // pool is full — queue the waiter
        this._waiters.push({ resolve, reject, tryGet });
      };

      tryGet();
    });
  }

  /**
   * Release a connection back to the pool.
   * Broken connections are discarded; the pool is replenished to min_size.
   */
  async release(conn) {
    this._inUse = Math.max(0, this._inUse - 1);

    if (this._closed || conn._broken) {
      try { await conn.end(); } catch (_) {}
      await this._replenish();
      return;
    }

    // If someone is waiting, hand it directly
    if (this._waiters.length > 0) {
      const waiter = this._waiters.shift();
      this._inUse++;
      return waiter.resolve(conn);
    }

    // Return to idle pool
    this._idle.push(conn);

    // Notify the next waiter if any appeared between checks
    this._drainWaiters();
  }

  _drainWaiters() {
    while (this._waiters.length > 0 && this._idle.length > 0) {
      const waiter = this._waiters.shift();
      const conn = this._idle.pop();
      this._inUse++;
      waiter.resolve(conn);
    }
  }

  async _replenish() {
    if (this._closed) return;
    while (this.totalOpen < this.min_size) {
      try {
        const conn = await this._openConnection();
        if (this._waiters.length > 0) {
          const waiter = this._waiters.shift();
          this._inUse++;
          waiter.resolve(conn);
        } else {
          this._idle.push(conn);
        }
      } catch (err) {
        console.error(
          `[pool:${this.tenant_id}] replenish failed: ${err.message}`
        );
        break;
      }
    }
  }

  /**
   * Close all connections in the pool (called on server shutdown).
   */
  async close() {
    this._closed = true;

    // reject all waiting acquires
    for (const w of this._waiters) {
      w.reject(new Error('pool closed'));
    }
    this._waiters = [];

    // close idle connections
    const closes = this._idle.map(c => c.end().catch(() => {}));
    this._idle = [];
    await Promise.all(closes);
  }
}

module.exports = { TenantPool };
