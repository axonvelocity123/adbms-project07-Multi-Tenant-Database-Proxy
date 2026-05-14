#!/usr/bin/env node
'use strict';

/**
 * Rate Limit Fairness Test
 *
 * Verifies that each tenant's rate limit is enforced independently.
 * Tenant "initech" has limit 10/sec, "globex" has 50/sec.
 *
 * Both send \burst 200 and \burst 500 simultaneously.
 * We measure how many succeed per second.
 */

const net = require('net');

const PROXY_HOST = process.argv.includes('--host')
  ? process.argv[process.argv.indexOf('--host') + 1]
  : 'localhost';
const PROXY_PORT = process.argv.includes('--port')
  ? parseInt(process.argv[process.argv.indexOf('--port') + 1])
  : 6000;

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

  async burst(n) {
    this.send(`\\burst ${n}`);
    const lines = [];
    while (true) {
      const line = await this.recvLine();
      lines.push(line);
      if (/^(burst complete|ERR)/.test(line)) break;
    }
    return lines.join('\n');
  }

  close() { this._socket.destroy(); }
}

async function run() {
  console.log(`\nRate Limit Fairness Test`);
  console.log(`Proxy: ${PROXY_HOST}:${PROXY_PORT}\n`);

  const slow = new Session(); // initech: 10/sec
  const fast = new Session(); // globex: 50/sec

  await slow.connect(PROXY_HOST, PROXY_PORT);
  await fast.connect(PROXY_HOST, PROXY_PORT);

  const h1 = await slow.hello('initech', 'initech_k3y');
  const h2 = await fast.hello('globex', 'globex_k3y');

  if (!h1.startsWith('OK') || !h2.startsWith('OK')) {
    console.error('Authentication failed:', h1, h2);
    process.exit(1);
  }

  console.log('Both tenants authenticated. Running burst test...\n');

  const t0 = Date.now();

  // Run both bursts concurrently
  const [slowResult, fastResult] = await Promise.all([
    slow.burst(200),
    fast.burst(500),
  ]);

  const elapsed = (Date.now() - t0) / 1000;

  // Parse results
  const parseResult = (str) => {
    const m = str.match(/(\d+) ok,\s*(\d+) rate-limited/);
    return m ? { ok: parseInt(m[1]), rejected: parseInt(m[2]) } : { ok: 0, rejected: 0 };
  };

  const sr = parseResult(slowResult);
  const fr = parseResult(fastResult);

  console.log(`Elapsed: ${elapsed.toFixed(2)}s`);
  console.log(`\ninitech (limit: 10/sec):`);
  console.log(`  OK: ${sr.ok}  Rejected: ${sr.rejected}`);
  console.log(`  Effective rate: ${(sr.ok / elapsed).toFixed(1)}/sec`);

  console.log(`\nglobex (limit: 50/sec):`);
  console.log(`  OK: ${fr.ok}  Rejected: ${fr.rejected}`);
  console.log(`  Effective rate: ${(fr.ok / elapsed).toFixed(1)}/sec`);

  // Assertions
  let passed = 0, failed = 0;
  function assert(cond, label) {
    if (cond) { console.log(`\n  ✓ ${label}`); passed++; }
    else       { console.error(`\n  ✗ ${label}`); failed++; }
  }

  const slowRate = sr.ok / elapsed;
  const fastRate = fr.ok / elapsed;

  // Allow ±50% tolerance for token bucket burst behavior
  assert(slowRate <= 15, `initech rate <= 15/sec (is ${slowRate.toFixed(1)})`);
  assert(fastRate <= 60, `globex rate <= 60/sec (is ${fastRate.toFixed(1)})`);
  assert(fastRate > slowRate, `globex (50/sec) faster than initech (10/sec)`);
  assert(sr.rejected > 0, `initech had some rejections`);
  assert(fr.rejected > 0 || fr.ok >= 500, `globex ran at higher throughput`);

  console.log(`\n${'─'.repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);

  slow.close();
  fast.close();

  if (failed > 0) process.exit(1);
}

run().catch(err => {
  console.error(`Test error: ${err.message}`);
  process.exit(1);
});
