'use strict';

const net      = require('net');
const readline = require('readline');
const { Client } = require('pg');
const { loadTenants } = require('./config');
const { checkQuery }  = require('./rewriter');

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

function formatResult(result, elapsed_ms) {
  if (!result.rows || result.rows.length === 0) {
    return `OK (${result.rowCount || 0} rows, ${elapsed_ms}ms)\n`;
  }
  const cols  = result.fields.map(f => f.name);
  const rows  = result.rows.map(r => cols.map(c => String(r[c] == null ? 'NULL' : r[c])));
  const widths = cols.map((c, i) => Math.max(c.length, ...rows.map(r => r[i].length)));
  const header = cols.map((c, i) => c.padEnd(widths[i])).join(' | ');
  const sep    = widths.map(w => '-'.repeat(w)).join('-+-');
  const body   = rows.map(r => r.map((v, i) => v.padEnd(widths[i])).join(' | ')).join('\n');
  return `${header}\n${sep}\n${body}\n(${result.rows.length} rows, ${elapsed_ms}ms)\n`;
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

  const activeSessions = new Map();
  for (const [tid] of tenants) activeSessions.set(tid, 0);

  let sessionIdCounter = 0;
  console.log(`[proxy] ready on port ${args.port}`);

  function handleClient(socket) {
    const sessionId = ++sessionIdCounter;
    let tenantEntry = null;
    let tenantId    = null;
    let conn        = null;

    socket.setEncoding('utf8');
    const rl = readline.createInterface({ input: socket, crlfDelay: Infinity });

    function send(msg) {
      if (!socket.destroyed) socket.write(msg.endsWith('\n') ? msg : msg + '\n');
    }

    async function close() {
      if (tenantId) {
        activeSessions.set(tenantId, Math.max(0, activeSessions.get(tenantId) - 1));
      }
      if (conn) {
        try { await conn.end(); } catch (_) {}
        conn = null;
      }
      if (!socket.destroyed) socket.destroy();
    }

    rl.on('line', async (rawLine) => {
      const line = rawLine.trim();
      if (!line) return;

      if (!tenantEntry) {
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
        const t = tenants.get(tid);
        if (!t) { send(`ERR unknown tenant: ${tid}`); close(); return; }
        if (t.api_key !== key) { send(`ERR invalid api key`); close(); return; }
        if (activeSessions.get(tid) >= t.max_connections) {
          send(`ERR tenant ${tid} at max connections (${t.max_connections})`);
          close(); return;
        }

        try {
          conn = new Client(backendConfig);
          await conn.connect();
          await conn.query(`SET search_path = "${t.schema}", public`);
        } catch (err) {
          send(`ERR backend connection failed: ${err.message}`);
          close(); return;
        }

        tenantEntry = t;
        tenantId    = tid;
        activeSessions.set(tid, activeSessions.get(tid) + 1);
        send(`OK ${sessionId}`);
        return;
      }

      if (line === 'QUIT') { send(`BYE`); close(); return; }

      if (line === '\\stats') {
        send([
          `tenant:      ${tenantId}`,
          `session id:  ${sessionId}`,
          `sessions:    ${activeSessions.get(tenantId)} / ${tenantEntry.max_connections}`,
          `rate limit:  ${tenantEntry.rate_limit}/sec`,
        ].join('\n'));
        return;
      }

      if (line === '\\tables') {
        try {
          const r = await conn.query(
            `SELECT tablename FROM pg_tables WHERE schemaname = '${tenantEntry.schema}' ORDER BY tablename`
          );
          if (r.rows.length === 0) {
            send(`(no tables in ${tenantEntry.schema})`);
          } else {
            send(r.rows.map(row => row.tablename).join('\n') + '\nOK');
          }
        } catch (err) {
          send(`ERR ${err.message}`);
        }
        return;
      }

      if (line.startsWith('QUERY ')) {
        const sql = line.slice(6).trim();
        if (!sql) { send(`ERR empty query`); return; }

        const check = checkQuery(sql);
        if (!check.ok) { send(`ERR ${check.reason}`); return; }

        try {
          const t0     = Date.now();
          const result = await conn.query(sql);
          const elapsed = Date.now() - t0;
          send(formatResult(result, elapsed));
        } catch (err) {
          const msg = err.message.replace(/^ERROR:\s*/i, '').replace(/\n.*/s, '');
          send(`ERR ${msg}`);
        }
        return;
      }

      send(`ERR unknown command. Use: HELLO, QUERY <sql>, \\stats, \\tables, QUIT`);
    });

    rl.on('close', () => close());
    socket.on('error', () => close());
  }

  const server = net.createServer(handleClient);
  server.listen(args.port, () => console.log(`[proxy] listening on port ${args.port}`));
  server.on('error', err => { console.error(`[proxy] error: ${err.message}`); process.exit(1); });

  process.on('SIGINT', async () => {
    console.log('\n[proxy] shutting down...');
    server.close();
    process.exit(0);
  });
}

main().catch(err => {
  console.error(`[proxy] fatal: ${err.message}`);
  process.exit(1);
});
