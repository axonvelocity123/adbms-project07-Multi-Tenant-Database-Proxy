#!/usr/bin/env node
'use strict';

/**
 * Isolation Test
 *
 * Tests that tenants cannot see each other's data and cannot escape
 * their schema via SQL injection attacks.
 *
 * Requires the proxy to be running with at least 3 tenants (acme, globex, initech).
 * Usage: node tests/isolation.js [--host localhost] [--port 6000]
 */

const net = require('net');

const PROXY_HOST = process.argv.includes('--host')
  ? process.argv[process.argv.indexOf('--host') + 1]
  : 'localhost';
const PROXY_PORT = process.argv.includes('--port')
  ? parseInt(process.argv[process.argv.indexOf('--port') + 1])
  : 6000;

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

// ─── Low-level session helper ────────────────────────────────────────────────

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
          if (this._waiters.length > 0) {
            this._waiters.shift()(line);
          }
        }
      });
    });
  }

  recvLine() {
    return new Promise(resolve => this._waiters.push(resolve));
  }

  send(msg) {
    this._socket.write(msg + '\n');
  }

  async hello(tenant, key) {
    this.send(`HELLO ${tenant} ${key}`);
    return this.recvLine();
  }

  async query(sql) {
    this.send(`QUERY ${sql}`);
    // Collect response lines until we see a terminal line
    const lines = [];
    while (true) {
      const line = await this.recvLine();
      lines.push(line);
      if (
        /^(OK|ERR|BYE)/.test(line) ||
        /^\(\d+ rows/.test(line) ||
        /^\(no tables/.test(line)
      ) break;
    }
    return lines.join('\n');
  }

  close() {
    this._socket.destroy();
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

async function run() {
  console.log(`\nConnecting to proxy at ${PROXY_HOST}:${PROXY_PORT}...\n`);

  // Open three sessions
  const acme    = new Session();
  const globex  = new Session();
  const initech = new Session();

  await acme.connect(PROXY_HOST, PROXY_PORT);
  await globex.connect(PROXY_HOST, PROXY_PORT);
  await initech.connect(PROXY_HOST, PROXY_PORT);

  // Authenticate
  const h1 = await acme.hello('acme', 'acme_k3y');
  const h2 = await globex.hello('globex', 'globex_k3y');
  const h3 = await initech.hello('initech', 'initech_k3y');

  console.log('=== Authentication ===');
  assert(h1.startsWith('OK'), 'acme authenticated');
  assert(h2.startsWith('OK'), 'globex authenticated');
  assert(h3.startsWith('OK'), 'initech authenticated');

  // ── Clean up from previous runs ────────────────────────────────────────
  await acme.query(`DROP TABLE IF EXISTS iso_users`);
  await globex.query(`DROP TABLE IF EXISTS iso_users`);
  await initech.query(`DROP TABLE IF EXISTS iso_users`);

  // ── Create tables with different schemas per tenant ────────────────────
  console.log('\n=== Schema isolation ===');

  let r;
  r = await acme.query(`CREATE TABLE iso_users (id INT PRIMARY KEY, name TEXT)`);
  assert(r.includes('OK'), 'acme: CREATE TABLE iso_users');

  r = await globex.query(`CREATE TABLE iso_users (id INT PRIMARY KEY, email TEXT)`);
  assert(r.includes('OK'), 'globex: CREATE TABLE iso_users (different columns)');

  r = await initech.query(`CREATE TABLE iso_users (id INT PRIMARY KEY, dept TEXT, salary INT)`);
  assert(r.includes('OK'), 'initech: CREATE TABLE iso_users (yet another schema)');

  // ── Insert different data ───────────────────────────────────────────────
  await acme.query(`INSERT INTO iso_users VALUES (1,'Ayesha'),(2,'Bilal'),(3,'Carol')`);
  await globex.query(`INSERT INTO iso_users VALUES (100,'bob@globex.com')`);
  await initech.query(`INSERT INTO iso_users VALUES (1,'Engineering',90000),(2,'HR',50000)`);

  // ── Each tenant sees only own data ─────────────────────────────────────
  r = await acme.query(`SELECT count(*) FROM iso_users`);
  assert(r.includes('3'), 'acme sees 3 rows (its own data only)');

  r = await globex.query(`SELECT count(*) FROM iso_users`);
  assert(r.includes('1'), 'globex sees 1 row (its own data only)');

  r = await initech.query(`SELECT count(*) FROM iso_users`);
  assert(r.includes('2'), 'initech sees 2 rows (its own data only)');

  // ── Cross-tenant reference is rejected ─────────────────────────────────
  console.log('\n=== Escape attempt: cross-schema reference ===');

  r = await acme.query(`SELECT * FROM tenant_globex.iso_users`);
  assert(r.startsWith('ERR'), 'acme: SELECT from tenant_globex rejected');

  r = await globex.query(`SELECT * FROM tenant_acme.iso_users`);
  assert(r.startsWith('ERR'), 'globex: SELECT from tenant_acme rejected');

  r = await initech.query(`INSERT INTO tenant_acme.iso_users VALUES (99,'Hacker')`);
  assert(r.startsWith('ERR'), 'initech: INSERT into tenant_acme rejected');

  // ── SET search_path injection ───────────────────────────────────────────
  console.log('\n=== Escape attempt: SET search_path ===');

  r = await acme.query(`SET search_path = tenant_globex`);
  assert(r.startsWith('ERR'), 'SET search_path rejected');

  r = await acme.query(`set search_path to public`);
  assert(r.startsWith('ERR'), 'set search_path (lowercase) rejected');

  // ── SET ROLE injection ──────────────────────────────────────────────────
  console.log('\n=== Escape attempt: SET ROLE ===');

  r = await acme.query(`SET ROLE postgres`);
  assert(r.startsWith('ERR'), 'SET ROLE rejected');

  r = await globex.query(`set role admin`);
  assert(r.startsWith('ERR'), 'set role (lowercase) rejected');

  // ── SET SESSION AUTHORIZATION ───────────────────────────────────────────
  r = await acme.query(`SET SESSION AUTHORIZATION postgres`);
  assert(r.startsWith('ERR'), 'SET SESSION AUTHORIZATION rejected');

  // ── Backend error does not corrupt pool ────────────────────────────────
  console.log('\n=== Pool health after backend error ===');

  r = await acme.query(`SELECT * FROM this_table_does_not_exist_xyz`);
  assert(r.startsWith('ERR'), 'syntax error caught');

  // Next query should still work
  r = await acme.query(`SELECT count(*) FROM iso_users`);
  assert(r.includes('3'), 'acme pool healthy after backend error');

  // ── globex still isolated after acme errors ─────────────────────────────
  r = await globex.query(`SELECT count(*) FROM iso_users`);
  assert(r.includes('1'), 'globex still isolated after acme errors');

  // ── Bad credentials ─────────────────────────────────────────────────────
  console.log('\n=== Authentication failure ===');

  const bad = new Session();
  await bad.connect(PROXY_HOST, PROXY_PORT);
  const hBad = await bad.hello('acme', 'wrong_key');
  assert(hBad.startsWith('ERR'), 'wrong api key rejected');
  bad.close();

  const unknown = new Session();
  await unknown.connect(PROXY_HOST, PROXY_PORT);
  const hUnknown = await unknown.hello('nosuchtenant', 'key');
  assert(hUnknown.startsWith('ERR'), 'unknown tenant rejected');
  unknown.close();

  // ── Cleanup ─────────────────────────────────────────────────────────────
  await acme.query(`DROP TABLE IF EXISTS iso_users`);
  await globex.query(`DROP TABLE IF EXISTS iso_users`);
  await initech.query(`DROP TABLE IF EXISTS iso_users`);

  acme.close();
  globex.close();
  initech.close();

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch(err => {
  console.error(`\nTest error: ${err.message}`);
  process.exit(1);
});
