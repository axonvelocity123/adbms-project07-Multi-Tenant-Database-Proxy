#!/usr/bin/env node
'use strict';

/**
 * Benchmark for the Multi-Tenant Proxy
 *
 * Measures:
 *   1. Throughput under a single tenant (SELECT 1, rate limit disabled via high config)
 *   2. Throughput under 5 tenants with 2 sessions each
 *   3. Connection pool effectiveness: pooled vs. (we measure pool overhead)
 *
 * Usage: node benchmark/bench.js [--host localhost] [--port 6000]
 */

const net  = require('net');

const HOST = process.argv.includes('--host')
  ? process.argv[process.argv.indexOf('--host') + 1]
  : 'localhost';
const PORT = process.argv.includes('--port')
  ? parseInt(process.argv[process.argv.indexOf('--port') + 1])
  : 6000;

// ─── Session helper ───────────────────────────────────────────────────────────

class Session {
  constructor() {
    this._socket = null;
    this._buf = '';
    this._waiters = [];
  }

  connect(host, port) {
    return new Promise((resolve, reject) => {
      this._socket = net.connect(port, host, resolve);
      this._socket.setEncoding('utf8');
      this._socket.on('error', reject);
      this._socket.on('data', chunk => {
        this._buf += chunk;
        const lines = this._buf.split('\n');
        this._buf = lines.pop();
        for (const line of lines) {
          if (this._waiters.length > 0) this._waiters.shift()(line);
        }
      });
    });
  }

  recvLine() {
    return new Promise(resolve => this._waiters.push(resolve));
  }

  send(msg) { this._socket.write(msg + '\n'); }

  async hello(tenant, key) {
    this.send(`HELLO ${tenant} ${key}`);
    return this.recvLine();
  }

  async recvResponse() {
    const lines = [];
    while (true) {
      const line = await this.recvLine();
      lines.push(line);
      if (/^(OK|ERR)/.test(line) || /^\(\d+ rows/.test(line)) break;
    }
    return lines.join('\n');
  }

  async query(sql) {
    this.send(`QUERY ${sql}`);
    return this.recvResponse();
  }

  close() { this._socket.destroy(); }
}

// ─── Benchmark helpers ────────────────────────────────────────────────────────

async function throughputTest(session, nQueries, sql) {
  const latencies = [];
  const t0 = Date.now();

  for (let i = 0; i < nQueries; i++) {
    const qt = Date.now();
    await session.query(sql);
    latencies.push(Date.now() - qt);
  }

  const elapsed = Date.now() - t0;
  const qps = (nQueries / elapsed * 1000).toFixed(0);

  latencies.sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.50)];
  const p95 = latencies[Math.floor(latencies.length * 0.95)];
  const p99 = latencies[Math.floor(latencies.length * 0.99)];

  return { qps: parseInt(qps), p50, p95, p99, elapsed };
}

function printTable(rows) {
  const headers = Object.keys(rows[0]);
  const widths = headers.map(h =>
    Math.max(h.length, ...rows.map(r => String(r[h]).length))
  );
  const sep  = widths.map(w => '─'.repeat(w)).join('─┼─');
  const head = headers.map((h, i) => h.padEnd(widths[i])).join(' │ ');
  console.log(head);
  console.log(sep);
  for (const row of rows) {
    console.log(headers.map((h, i) => String(row[h]).padEnd(widths[i])).join(' │ '));
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  Multi-Tenant Proxy Benchmark`);
  console.log(`  Target: ${HOST}:${PORT}`);
  console.log(`${'═'.repeat(60)}\n`);

  // ── Benchmark 1: Single tenant throughput ─────────────────────────────
  console.log('Benchmark 1: Single-tenant throughput (globex, 500 queries)\n');

  const s1 = new Session();
  await s1.connect(HOST, PORT);
  await s1.hello('globex', 'globex_k3y');

  const b1 = await throughputTest(s1, 500, 'SELECT 1');
  printTable([{
    queries: 500,
    qps: b1.qps,
    'p50 (ms)': b1.p50,
    'p95 (ms)': b1.p95,
    'p99 (ms)': b1.p99,
    'total (ms)': b1.elapsed,
  }]);
  s1.close();

  // ── Benchmark 2: Multi-tenant concurrent throughput ───────────────────
  console.log('\n\nBenchmark 2: 3 tenants × 1 session each, concurrent (100 queries each)\n');

  const tenants = [
    { id: 'acme',    key: 'acme_k3y'    },
    { id: 'globex',  key: 'globex_k3y'  },
    { id: 'initech', key: 'initech_k3y' },
  ];

  const sessions = [];
  for (const t of tenants) {
    const s = new Session();
    await s.connect(HOST, PORT);
    await s.hello(t.id, t.key);
    sessions.push({ tenant: t.id, session: s });
  }

  const N = 100;
  const t0 = Date.now();
  const results = await Promise.all(
    sessions.map(({ tenant, session }) =>
      throughputTest(session, N, 'SELECT 1').then(r => ({ tenant, ...r }))
    )
  );
  const totalElapsed = Date.now() - t0;
  const totalQps = results.reduce((a, r) => a + r.qps, 0);

  printTable(results.map(r => ({
    tenant:     r.tenant,
    queries:    N,
    qps:        r.qps,
    'p50 (ms)': r.p50,
    'p95 (ms)': r.p95,
    'p99 (ms)': r.p99,
  })));
  console.log(`\nAggregate: ${totalQps} qps total across ${tenants.length} tenants`);
  console.log(`Wall-clock time: ${totalElapsed}ms`);

  for (const { session } of sessions) session.close();

  // ── Benchmark 3: Pool effectiveness ───────────────────────────────────
  // We simulate the cost of having the pool available (warm connections)
  // vs cold by measuring first-query latency vs subsequent latency.
  console.log('\n\nBenchmark 3: Pool warm-up effect (first query vs subsequent)\n');

  const s3 = new Session();
  await s3.connect(HOST, PORT);
  await s3.hello('acme', 'acme_k3y');

  const latencies3 = [];
  for (let i = 0; i < 50; i++) {
    const t = Date.now();
    await s3.query('SELECT 1');
    latencies3.push(Date.now() - t);
  }

  const firstBatch  = latencies3.slice(0, 5);
  const steadyState = latencies3.slice(10);
  const avgFirst    = firstBatch.reduce((a, b) => a + b, 0) / firstBatch.length;
  const avgSteady   = steadyState.reduce((a, b) => a + b, 0) / steadyState.length;

  printTable([
    { phase: 'first 5 queries',   'avg latency (ms)': avgFirst.toFixed(2),  note: 'connection possibly cold' },
    { phase: 'queries 11-50',     'avg latency (ms)': avgSteady.toFixed(2), note: 'pool fully warm' },
  ]);

  s3.close();

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log('\n\n' + '═'.repeat(60));
  console.log('  Summary');
  console.log('═'.repeat(60));
  console.log(`  Single-tenant throughput: ${b1.qps} qps`);
  console.log(`  Multi-tenant aggregate:   ${totalQps} qps`);
  console.log(`  Warm pool avg latency:    ${avgSteady.toFixed(2)}ms`);
  console.log('═'.repeat(60) + '\n');
}

main().catch(err => {
  console.error(`Benchmark error: ${err.message}`);
  process.exit(1);
});
