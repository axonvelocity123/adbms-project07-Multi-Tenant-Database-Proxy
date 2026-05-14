# Multi-Tenant Database Proxy — Phase 2

**ADBMS Project 02 — Computer Science 4th Semester**

Phase 2 adds connection pooling, token bucket rate limiting, and per-tenant metering on top of Phase 1.

---

## What's New in Phase 2

- **Per-tenant connection pool** (`src/pool.js`) — pre-warmed connections, min/max sizing, check-out/check-in
- **Token bucket rate limiter** (`src/rateLimiter.js`) — per-tenant queries/sec limit with burst support
- **Metering counters** (`src/metrics.js`) — tracks queries, bytes sent/received, cpu time
- **`\stats`** — now shows pool state, metering counters, and rate limit fill level
- **`\burst N`** — sends N rapid SELECT 1 queries to exercise the rate limiter

---

## Architecture

```
[ tenant clients ]
        |
        v
+---------------------+
|  Client Listener    |  TCP server, HELLO auth, line-based protocol
+---------------------+
        |
        v
+---------------------+
|  Query Rewriter     |  Denylist check — rejects cross-schema references
+---------------------+
        |
        v
+---------------------+
|  Rate Limiter       |  Per-tenant token bucket
+---------------------+
        |
        v
+---------------------+
|  Connection Pool    |  Per-tenant pool, search_path pre-set
+---------------------+
        |
        v
  [ PostgreSQL ]
```

---

## Prerequisites

- Node.js 18+
- Docker

---

## Setup & Running

**Step 1 — Start PostgreSQL in Docker**
```bash
docker run --rm -d -p 5432:5432 --name pg -e POSTGRES_PASSWORD=secret postgres:16
```

**Step 2 — Install dependencies**
```bash
npm install
```

**Step 3 — Start the proxy**
```bash
node src/proxy.js \
  --port 6000 \
  --backend localhost:5432 \
  --backend-user postgres \
  --backend-password secret \
  --backend-db postgres \
  --tenants tenants.conf
```

Expected startup output:
```
[proxy] loaded 3 tenants: acme, globex, initech
[proxy] ensuring schemas exist on backend...
[proxy]   schema tenant_acme: ok
[proxy]   schema tenant_globex: ok
[proxy]   schema tenant_initech: ok
[proxy] warming up connection pools...
[proxy]   pool acme: min=1 max=8 open=1
[proxy]   pool globex: min=1 max=16 open=1
[proxy]   pool initech: min=1 max=4 open=1
[proxy] ready on port 6000
[proxy] listening on port 6000
```

---

## Tenant Config Format

```
# tenant_id:api_key:rate_limit_per_sec:max_connections
acme:acme_k3y:20:8
globex:globex_k3y:50:16
initech:initech_k3y:10:4
```

---

## Supported Client Commands

| Command         | Description |
|-----------------|-------------|
| `<any SQL>`     | Execute SQL in your tenant's schema |
| `\stats`        | Show pool usage, metering counters, rate limit |
| `\tables`       | List tables in your schema |
| `\burst N`      | Send N rapid SELECT 1 queries (rate limit test) |
| `exit` / `quit` | Close the session |

---

## Running Tests

```bash
# Unit tests — no proxy needed
npm test

# Isolation tests — proxy must be running
node tests/isolation.js --host localhost --port 6000

# Rate limit fairness test — proxy must be running
node tests/ratelimit.js --host localhost --port 6000
```

---

## Running the Benchmark

```bash
node benchmark/bench.js --host localhost --port 6000
```

---

## Connection Pool Design

Each tenant gets its own pool. Connections are pre-opened at startup with `SET search_path = tenant_<id>` applied permanently. This means:

- A connection from the acme pool **always** resolves to `tenant_acme` schema
- It is **impossible** to accidentally serve a globex query on an acme connection
- Pool size: min=1, max=tenant's `max_connections` from config

---

## Rate Limiter Design

Token bucket algorithm per tenant:

- Bucket starts full at `rate_limit_per_sec` tokens
- Each query consumes 1 token
- Tokens refill at `rate_limit_per_sec` per second
- Bursts up to the bucket capacity are allowed
- Queries arriving when bucket is empty are rejected with retry time

---

## Known Limitations

- Denylist is regex-based, not a full SQL parser
- No TLS between client and proxy
- Tenant configuration is static — proxy must be restarted to add or remove tenants
