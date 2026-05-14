'use strict';

/**
 * Unit tests for:
 *   - Query denylist checker (rewriter.js)
 *   - Token bucket rate limiter (rateLimiter.js)
 */

const { checkQuery }  = require('../src/rewriter');
const { RateLimiter } = require('../src/rateLimiter');

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

// ─── Denylist tests ───────────────────────────────────────────────────────────
console.log('\n=== Denylist / checkQuery ===');

// Queries that SHOULD be allowed
assert(checkQuery(`SELECT * FROM users`).ok,                             'plain SELECT allowed');
assert(checkQuery(`INSERT INTO orders VALUES (1, 'x')`).ok,              'INSERT allowed');
assert(checkQuery(`CREATE TABLE products (id INT PRIMARY KEY)`).ok,      'CREATE TABLE allowed');
assert(checkQuery(`UPDATE users SET name='Bob' WHERE id=1`).ok,          'UPDATE allowed');
assert(checkQuery(`DELETE FROM users WHERE id=99`).ok,                   'DELETE allowed');
assert(checkQuery(`SELECT * FROM pg_tables`).ok,                         'pg_tables introspection allowed');
assert(checkQuery(`SELECT * FROM information_schema.tables`).ok,         'information_schema allowed');
assert(checkQuery(`SELECT count(*) FROM users`).ok,                      'aggregate allowed');
assert(checkQuery(`ALTER TABLE users ADD COLUMN email TEXT`).ok,         'ALTER TABLE allowed');
assert(checkQuery(`DROP TABLE IF EXISTS old_data`).ok,                   'DROP TABLE allowed');

// Queries that SHOULD be rejected
assert(!checkQuery(`SELECT * FROM tenant_globex.users`).ok,              'cross-tenant schema ref rejected');
assert(!checkQuery(`SELECT * FROM tenant_acme.orders`).ok,               'cross-tenant schema ref rejected (2)');
assert(!checkQuery(`SET search_path = tenant_acme`).ok,                  'SET search_path rejected');
assert(!checkQuery(`set search_path TO public`).ok,                      'SET search_path (lowercase) rejected');
assert(!checkQuery(`SET ROLE admin`).ok,                                  'SET ROLE rejected');
assert(!checkQuery(`set role postgres`).ok,                               'SET ROLE (lowercase) rejected');
assert(!checkQuery(`SET SESSION AUTHORIZATION postgres`).ok,             'SET SESSION AUTHORIZATION rejected');
assert(!checkQuery(`SELECT 1; SET search_path = tenant_x`).ok,           'injected SET search_path rejected');
assert(!checkQuery(`INSERT INTO tenant_other.secrets VALUES (1)`).ok,    'cross-schema INSERT rejected');
assert(!checkQuery(`UPDATE tenant_acme.users SET name='x'`).ok,          'cross-schema UPDATE rejected');

// ─── Rate limiter tests ───────────────────────────────────────────────────────
console.log('\n=== Token Bucket Rate Limiter ===');

{
  const rl = new RateLimiter(10); // 10 queries/sec

  // Should allow first 10 immediately (bucket starts full)
  let allowed = 0;
  for (let i = 0; i < 10; i++) {
    if (rl.consume().allowed) allowed++;
  }
  assert(allowed === 10, 'first 10 queries allowed (full bucket)');

  // 11th should be rejected
  assert(!rl.consume().allowed, '11th query rejected (bucket empty)');
}

{
  const rl = new RateLimiter(5); // 5/sec = 1 token per 200ms

  // drain bucket
  for (let i = 0; i < 5; i++) rl.consume();
  assert(!rl.consume().allowed, 'bucket empty after draining');

  // retry_ms should be positive
  rl.current_tokens = 0;
  rl.last_refill_time = Date.now();
  const result = rl.consume();
  assert(!result.allowed && result.retry_ms > 0, 'retry_ms is positive when rejected');
}

{
  // Simulate time passing: manually set last_refill_time in the past
  const rl = new RateLimiter(20);
  for (let i = 0; i < 20; i++) rl.consume(); // drain
  assert(!rl.consume().allowed, 'bucket empty');

  // Simulate 1 second passing
  rl.last_refill_time = Date.now() - 1000;
  assert(rl.consume().allowed, 'bucket refills after 1 second');
}

{
  // Capacity cap: even after long idle, bucket shouldn't exceed capacity
  const rl = new RateLimiter(10);
  rl.last_refill_time = Date.now() - 60000; // 60 seconds
  rl.current_tokens = 0;
  const r = rl.consume();
  // After 60 seconds at 10/sec = 600 tokens, but cap is 10
  assert(r.allowed, 'bucket allows after long idle');
  // Check internal: should be capped at capacity-1 after one consume
  assert(rl.current_tokens <= rl.capacity, 'bucket capped at capacity');
}

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
