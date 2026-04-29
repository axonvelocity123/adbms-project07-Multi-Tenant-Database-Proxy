# Multi-Tenant Database Proxy

**ADBMS Project 02 — Computer Science 4th Semester**

A proxy that sits in front of a single shared PostgreSQL server and isolates each tenant in their own schema. Built in Node.js using the `pg` library.

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
|  PostgreSQL Backend |  Fresh connection per session, search_path pre-set
+---------------------+
        |
        v
  [ PostgreSQL ]
```

Every tenant query passes through every layer. Isolation is enforced at two levels:

1. **search_path** — every connection has `SET search_path = tenant_<id>` applied immediately after login, so all unqualified table names resolve to that tenant's schema only.
2. **Denylist** — incoming SQL is checked for explicit cross-schema references, `SET search_path`, `SET ROLE`, and `SET SESSION AUTHORIZATION`. Any match is rejected before the query reaches the backend.

---

## What's Implemented (Phase 1)

- TCP server accepting multiple concurrent clients
- Tenant config file loader (`src/config.js`)
- `HELLO`-based authentication with API key verification
- Per-tenant session tracking and `max_connections` enforcement
- Schema creation at startup (`CREATE SCHEMA IF NOT EXISTS` for each tenant)
- Per-session PostgreSQL connection with `SET search_path` applied immediately after login
- `QUERY` command handler — forwards SQL, returns results or errors
- Denylist check (`src/rewriter.js`) blocking all cross-schema escape attempts
- `tenant-cli` command-line client (`cli/client.js`)

> Phase 1 uses a fresh connection per session. Connection pooling and rate limiting are Phase 2.

---

## Prerequisites

- Node.js 18+
- PostgreSQL 14+ (local or Docker)

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
[proxy] ready on port 6000
[proxy] listening on port 6000
```

### Proxy CLI Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--port` | 6000 | Port the proxy listens on |
| `--backend` | localhost:5432 | PostgreSQL host:port |
| `--backend-user` | postgres | PostgreSQL user |
| `--backend-password` | secret | PostgreSQL password |
| `--backend-db` | postgres | PostgreSQL database |
| `--tenants` | tenants.conf | Path to tenant config file |

---

## Tenant Config Format

File: `tenants.conf`

```
# tenant_id:api_key:rate_limit_per_sec:max_connections
acme:acme_k3y:20:8
globex:globex_k3y:50:16
initech:initech_k3y:10:4
```

- **tenant_id** — lowercase alphanumeric, used as schema prefix (`tenant_acme`)
- **api_key** — must be presented at login
- **rate_limit_per_sec** — parsed and stored (enforced in Phase 2)
- **max_connections** — max concurrent sessions for this tenant, enforced now

---

## Client Protocol

### Connection Handshake

```
HELLO tenant_id api_key
```

Proxy responds with `OK session_id` or `ERR reason`.

Possible errors: `ERR unknown tenant: X`, `ERR invalid api key`, `ERR tenant X at max connections (N)`.
Any command sent before a successful `HELLO` disconnects the client immediately.

### Query Response Format

**Non-SELECT (INSERT, UPDATE, DELETE, CREATE, etc.):**
```
OK (N rows, Tms)
```

**SELECT:**
```
col1 | col2
-----+-----
v1   | v2
(N rows, Tms)
```

**Error:**
```
ERR reason
```

---

## Supported Client Commands

| Command       | Description                         |
|---------------|-------------------------------------|
| `<any SQL>`   | Execute SQL in your tenant's schema |
| `\stats`      | Show session info and connection count |
| `\tables`     | List tables in your schema          |
| `exit` / `quit` | Close the session                 |

---

## Schema Isolation

Each tenant's connection has `SET search_path = tenant_<id>` applied right after the `HELLO` handshake succeeds. This means:

- `CREATE TABLE users (...)` creates `tenant_acme.users` for acme
- `SELECT * FROM users` reads from `tenant_acme.users` — never another tenant's table
- No query rewriting needed — PostgreSQL resolves all unqualified names to the correct schema automatically

The denylist (`src/rewriter.js`) additionally rejects any query containing:

| Pattern | Blocks |
|---------|--------|
| `tenant_X.something` | Explicit cross-schema table reference |
| `SET search_path` | Tenant trying to change their own schema |
| `SET ROLE` | Tenant trying to impersonate another user |
| `SET SESSION AUTHORIZATION` | Same as above, alternate syntax |

---

## Testing Walkthrough

The proxy must already be running. Open a separate terminal for each tenant.

---

### Terminal 2 — acme session

```bash
node cli/client.js --host localhost --port 6000 --tenant acme --api-key acme_k3y
```

**Basic DDL and queries:**
```sql
CREATE TABLE users (id INT PRIMARY KEY, name TEXT);
INSERT INTO users VALUES (1, 'Ayesha'), (2, 'Bilal'), (3, 'Carol');
SELECT * FROM users;
```

Expected:
```
id | name
---+-------
1  | Ayesha
2  | Bilal
3  | Carol
(3 rows, 6ms)
```

**Escape attack attempts — all must be rejected:**
```sql
SELECT * FROM tenant_globex.users;
SET search_path = tenant_globex;
SET ROLE postgres;
```

Expected:
```
ERR explicit cross-tenant schema reference is not allowed
ERR SET search_path is not allowed from tenant sessions
ERR SET ROLE is not allowed from tenant sessions
```

---

### Terminal 3 — globex session (keep acme open)

```bash
node cli/client.js --host localhost --port 6000 --tenant globex --api-key globex_k3y
```

```sql
CREATE TABLE users (id INT PRIMARY KEY, email TEXT);
INSERT INTO users VALUES (100, 'bob@globex.com');
SELECT * FROM users;
```

Expected:
```
id  | email
----+---------------
100 | bob@globex.com
(1 rows, 4ms)
```

**Globex must not see acme's data:**
```sql
SELECT * FROM tenant_acme.users;
```

Expected:
```
ERR explicit cross-tenant schema reference is not allowed
```

---

### Terminal 4 — initech session

```bash
node cli/client.js --host localhost --port 6000 --tenant initech --api-key initech_k3y
```

```sql
CREATE TABLE users (id INT PRIMARY KEY, dept TEXT);
INSERT INTO users VALUES (1, 'Engineering'), (2, 'HR');
SELECT * FROM users;
```

Expected:
```
id | dept
---+------------
1  | Engineering
2  | HR
(2 rows, 5ms)
```

---

### Terminal 2 — back to acme, confirm still isolated

```sql
SELECT * FROM users;
```

Returns acme's own 3 rows. Unaffected by globex and initech.

---

---

### Startup schema verification

Right after starting the proxy, connect directly to PostgreSQL:

```bash
docker exec -it pg psql -U postgres -d postgres
```

Run:
```sql
\dn
```

Expected:
```
      Name      |       Owner
----------------+-------------------
 public         | pg_database_owner
 tenant_acme    | postgres
 tenant_globex  | postgres
 tenant_initech | postgres
(4 rows)
```

All three schemas created automatically at proxy startup.

---

### Session tracking

Inside any connected tenant session run:
```
\stats
```

Expected:
```
tenant:      acme
session id:  1
sessions:    1 / 8
rate limit:  20/sec
```

Open a second acme session and run `\stats` again — sessions increments to `2 / 8`. Confirms max_connections tracking is working.

---

### Bad credentials test

```bash
node cli/client.js --host localhost --port 6000 --tenant acme --api-key wrongkey
```
Expected: `auth failed: ERR invalid api key`

```bash
node cli/client.js --host localhost --port 6000 --tenant nobody --api-key anything
```
Expected: `auth failed: ERR unknown tenant: nobody`

---

### Backend verification

Connect directly to PostgreSQL to confirm data is in the correct schemas:

```bash
docker exec -it pg psql -U postgres -d postgres
```

```sql
SELECT * FROM tenant_acme.users;
SELECT * FROM tenant_globex.users;
SELECT * FROM tenant_initech.users;
```

Each query returns only that tenant's data, confirming the proxy routed everything to the correct schema.

---

## Known Limitations

- Denylist is regex-based, not a full SQL parser — sufficiently obfuscated SQL may bypass it
- No connection pooling (Phase 2)
- No rate limiting (Phase 2)
- No TLS between client and proxy (plaintext TCP)
- Tenant configuration is static — proxy must be restarted to add or remove tenants
