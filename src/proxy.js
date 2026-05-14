'use strict';

const net        = require('net');
const readline   = require('readline');
const { Client } = require('pg');
const { loadTenants } = require('./config');
const { checkQuery }  = require('./rewriter');
const { TenantPool }  = require('./pool');
const { RateLimiter } = require('./rateLimiter');
const { Metrics }     = require('./metrics');

function parseArgs(argv) {
  const args = {
    port: 6000,
    backendHost: 'localhost',
    backendPort: 5432,
    backendUser: 'postgres',
    backendPassword: 'secret',
    backendDb: 'postgres',
    tenantsFile: 'tenants.conf',
  };
  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case '--port':             args.port            = parseInt(argv[++i]); break;
      case '--backend':
        const [h, p] = argv[++i].split(':');
        args.backendHost = h;
        if (p) args.backendPort = parseInt(p);
        break;
      case '--backend-user':     args.backendUser     = argv[++i]; break;
      case '--backend-password': args.backendPassword = argv[++i]; break;
      case '--backend-db':       args.backendDb       = argv[++i]; break;
      case '--tenants':          args.tenantsFile     = argv[++i]; break;
      default:
        console.error(`Unknown argument: ${argv[i]}`);
        process.exit(1);
    }
  }
  return args;
}

function formatResult(result, elapsed_ms, pool) {
  if (!result.rows || result.rows.length === 0) {
    return `OK (${result.rowCount || 0} rows, ${elapsed_ms}ms, pool: ${pool.inUseCount}/${pool.max_size} in use)\n`;
  }
  const cols   = result.fields.map(f => f.name);
  const rows   = result.rows.map(r => cols.map(c => String(r[c] == null ? 'NULL' : r[c])));
  const widths = cols.map((c, i) => Math.max(c.length, ...rows.map(r => r[i].length)));
  const header = cols.map((c, i) => c.padEnd(widths[i])).join(' | ');
  const sep    = widths.map(w => '-'.repeat(w)).join('-+-');
  const body   = rows.map(r => r.map((v, i) => v.padEnd(widths[i])).join(' | ')).join('\n');
  return `${header}\n${sep}\n${body}\n(${result.rows.length} rows, ${elapsed_ms}ms, pool: ${pool.inUseCount}/${pool.max_size} in use)\n`;
}

function resultBytes(result) {
  if (!result.rows || result.rows.length === 0) return 0;
  let total = 0;
  for (const row of result.rows)
    for (const v of Object.values(row))
      total += v == null ? 0 : String(v).length;
  return total;
}

async function main() {
  const args = parseArgs(process.argv);

  let tenants;
  try {
    tenants = loadTenants(args.tenantsFile);
  } catch (err) {
    console.error(`[proxy] config error: ${err.message}`);
    process.exit(1);
  }
  console.log(`[proxy] loaded ${tenants.size} tenants: ${[...tenants.keys()].join(', ')}`);

  const backendConfig = {
    host:     args.backendHost,
    port:     args.backendPort,
    user:     args.backendUser,
    password: args.backendPassword,
    database: args.backendDb,
  };

  console.log(`[proxy] ensuring schemas exist on backend...`);
  {
    const admin = new Client(backendConfig);
    await admin.connect();
    for (const [, t] of tenants) {
      await admin.query(`CREATE SCHEMA IF NOT EXISTS "${t.schema}"`);
      console.log(`[proxy]   schema ${t.schema}: ok`);
    }
    await admin.end();
  }

  // build per-tenant state: pool + rate limiter + metrics + session counter
  const tenantState = new Map();
  for (const [tid, tenant] of tenants) {
    tenantState.set(tid, {
      tenant,
      pool:        new TenantPool(tenant, backendConfig),
      rateLimiter: new RateLimiter(tenant.rate_limit),
      metrics:     new Metrics(),
      activeSessions: 0,
    });
  }

  // warm up pools
  console.log(`[proxy] warming up connection pools...`);
  for (const [tid, state] of tenantState) {
    await state.pool.warmUp();
    console.log(`[proxy]   pool ${tid}: min=${state.pool.min_size} max=${state.pool.max_size} open=${state.pool.totalOpen}`);
  }
  console.log(`[proxy] ready on port ${args.port}`);

  let sessionIdCounter = 0;

  function handleClient(socket) {
    const sessionId = ++sessionIdCounter;
    let state    = null;
    let tenantId = null;

    socket.setEncoding('utf8');
    const rl = readline.createInterface({ input: socket, crlfDelay: Infinity });

    function send(msg) {
      if (!socket.destroyed) socket.write(msg.endsWith('\n') ? msg : msg + '\n');
    }

    function close() {
      if (state) state.activeSessions = Math.max(0, state.activeSessions - 1);
      if (!socket.destroyed) socket.destroy();
    }

    rl.on('line', async (rawLine) => {
      const line = rawLine.trim();
      if (!line) return;

      // HELLO
      if (!state) {
        if (!line.startsWith('HELLO ')) {
          send(`ERR must send HELLO tenant_id api_key first`);
          close(); return;
        }
        const parts = line.split(/\s+/);
        if (parts.length !== 3) {
          send(`ERR usage: HELLO tenant_id api_key`);
          close(); return;
        }
        const [, tid, key] = parts;
        const ts = tenantState.get(tid);
        if (!ts) { send(`ERR unknown tenant: ${tid}`); close(); return; }
        if (ts.tenant.api_key !== key) { send(`ERR invalid api key`); close(); return; }
        if (ts.activeSessions >= ts.tenant.max_connections) {
          send(`ERR tenant ${tid} at max connections (${ts.tenant.max_connections})`);
          close(); return;
        }
        state    = ts;
        tenantId = tid;
        state.activeSessions++;
        send(`OK ${sessionId}`);
        return;
      }

      // QUIT
      if (line === 'QUIT') { send(`BYE`); close(); return; }

      // \stats
      if (line === '\\stats') {
        const m = state.metrics.snapshot();
        const p = state.pool;
        const r = state.rateLimiter;
        send([
          `tenant:           ${tenantId}`,
          `session id:       ${sessionId}`,
          `sessions:         ${state.activeSessions} / ${state.tenant.max_connections}`,
          `queries total:    ${m.queries_total}`,
          `queries rejected: ${m.queries_rejected}`,
          `bytes sent:       ${m.bytes_sent}`,
          `bytes recv:       ${m.bytes_received}`,
          `cpu ms:           ${m.cpu_ms}`,
          `pool in use:      ${p.inUseCount}`,
          `pool idle:        ${p.idleCount}`,
          `pool max:         ${p.max_size}`,
          `rate limit:       ${state.tenant.rate_limit}/sec (bucket: ${(r.fillLevel()*100).toFixed(0)}% full)`,
        ].join('\n'));
        return;
      }

      // \tables
      if (line === '\\tables') {
        try {
          const conn = await state.pool.acquire();
          let r;
          try {
            r = await conn.query(
              `SELECT tablename FROM pg_tables WHERE schemaname = '${state.tenant.schema}' ORDER BY tablename`
            );
          } finally {
            await state.pool.release(conn);
          }
          if (r.rows.length === 0) {
            send(`(no tables in ${state.tenant.schema})`);
          } else {
            send(r.rows.map(row => row.tablename).join('\n') + '\nOK');
          }
        } catch (err) {
          send(`ERR ${err.message}`);
        }
        return;
      }

      // \burst N
      if (line.startsWith('\\burst ')) {
        const n = parseInt(line.slice(7).trim(), 10);
        if (isNaN(n) || n <= 0) { send(`ERR usage: \\burst N`); return; }
        let ok = 0, rejected = 0;
        for (let i = 0; i < n; i++) {
          const rl = state.rateLimiter.consume();
          if (!rl.allowed) {
            rejected++;
            state.metrics.recordRejection();
            if (rejected === 1) {
              send(`ERR rate limit exceeded (${state.tenant.rate_limit} queries/sec, retry in ${rl.retry_ms}ms)`);
            }
            continue;
          }
          try {
            const conn = await state.pool.acquire();
            try { await conn.query('SELECT 1'); } finally { await state.pool.release(conn); }
            ok++;
            state.metrics.recordSuccess('SELECT 1', 1, 0);
          } catch (err) {
            send(`ERR ${err.message}`);
          }
        }
        send(`burst complete: ${ok} ok, ${rejected} rate-limited`);
        return;
      }

      // QUERY
      if (line.startsWith('QUERY ')) {
        const sql = line.slice(6).trim();
        if (!sql) { send(`ERR empty query`); return; }

        const check = checkQuery(sql);
        if (!check.ok) { send(`ERR ${check.reason}`); return; }

        const rl = state.rateLimiter.consume();
        if (!rl.allowed) {
          state.metrics.recordRejection();
          send(`ERR rate limit exceeded (${state.tenant.rate_limit}/sec, retry in ${rl.retry_ms}ms)`);
          return;
        }

        try {
          const t0   = Date.now();
          const conn = await state.pool.acquire();
          let result;
          try {
            result = await conn.query(sql);
          } finally {
            await state.pool.release(conn);
          }
          const elapsed = Date.now() - t0;
          state.metrics.recordSuccess(sql, resultBytes(result), elapsed);
          send(formatResult(result, elapsed, state.pool));
        } catch (err) {
          const msg = err.message.replace(/^ERROR:\s*/i, '').replace(/\n.*/s, '');
          send(`ERR ${msg}`);
        }
        return;
      }

      send(`ERR unknown command. Use: HELLO, QUERY <sql>, \\stats, \\tables, \\burst <n>, QUIT`);
    });

    rl.on('close', () => close());
    socket.on('error', () => close());
  }

  const server = net.createServer(handleClient);
  server.listen(args.port, () => console.log(`[proxy] listening on port ${args.port}`));
  server.on('error', err => { console.error(`[proxy] error: ${err.message}`); process.exit(1); });

  async function shutdown(signal) {
    console.log(`\n[proxy] received ${signal}, shutting down...`);
    server.close();
    for (const [, state] of tenantState) await state.pool.close();
    console.log(`[proxy] all pools closed. goodbye.`);
    process.exit(0);
  }

  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(err => {
  console.error(`[proxy] fatal: ${err.message}`);
  process.exit(1);
});
