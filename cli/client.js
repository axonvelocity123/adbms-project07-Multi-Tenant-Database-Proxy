#!/usr/bin/env node
'use strict';

const net      = require('net');
const readline = require('readline');

function parseArgs(argv) {
  const args = { host: 'localhost', port: 6000, tenant: null, apiKey: null };
  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case '--host':    args.host   = argv[++i]; break;
      case '--port':    args.port   = parseInt(argv[++i]); break;
      case '--tenant':  args.tenant = argv[++i]; break;
      case '--api-key': args.apiKey = argv[++i]; break;
      default:
        console.error(`Unknown argument: ${argv[i]}`);
        process.exit(1);
    }
  }
  if (!args.tenant || !args.apiKey) {
    console.error('Usage: client.js --host H --port P --tenant ID --api-key KEY');
    process.exit(1);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);

  const socket = net.connect(args.port, args.host);

  let buf = '';
  const pendingLines = [];
  let lineWaiter = null;

  socket.setEncoding('utf8');
  socket.on('data', chunk => {
    buf += chunk;
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (lineWaiter) {
        const resolve = lineWaiter;
        lineWaiter = null;
        resolve(line);
      } else {
        pendingLines.push(line);
      }
    }
  });

  socket.on('error', err => {
    console.error(`\nconnection error: ${err.message}`);
    process.exit(1);
  });

  socket.on('close', () => {
    console.log('\ndisconnected from proxy');
    process.exit(0);
  });

  function recvLine() {
    return new Promise((resolve, reject) => {
      if (pendingLines.length > 0) return resolve(pendingLines.shift());
      if (socket.destroyed) return reject(new Error('socket closed'));
      lineWaiter = resolve;
    });
  }

  async function recvResponse() {
    const lines = [];
    while (true) {
      const line = await recvLine();
      lines.push(line);
      if (
        /^(OK|ERR|BYE|burst complete)/.test(line) ||
        /^\(\d+ rows/.test(line) ||
        /^rate limit:/.test(line) ||
        /^\(no tables/.test(line)
      ) {
        break;
      }
    }
    return lines.join('\n');
  }

  function send(msg) {
    socket.write(msg + '\n');
  }

  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });

  send(`HELLO ${args.tenant} ${args.apiKey}`);
  const helloResp = await recvLine();

  if (!helloResp.startsWith('OK')) {
    console.error(`auth failed: ${helloResp}`);
    socket.destroy();
    process.exit(1);
  }

  const sessionId = helloResp.split(' ')[1];
  console.log(`connected as tenant '${args.tenant}' (session id ${sessionId})`);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  function prompt() {
    rl.question(`${args.tenant}> `, async (input) => {
      const line = input.trim();

      if (!line) { prompt(); return; }

      if (line === 'exit' || line === 'quit' || line === 'QUIT') {
        send('QUIT');
        const bye = await recvLine();
        console.log(bye);
        rl.close();
        socket.destroy();
        return;
      }

      if (line === '\\stats' || line === '\\tables') {
        send(line);
        const resp = await recvResponse();
        console.log(resp);
        prompt();
        return;
      }

      if (line.startsWith('\\burst ')) {
        send(line);
        const resp = await recvResponse();
        console.log(resp);
        prompt();
        return;
      }

      send(`QUERY ${line}`);
      const resp = await recvResponse();
      console.log(resp);
      prompt();
    });
  }

  rl.on('close', () => {
    socket.destroy();
    process.exit(0);
  });

  prompt();
}

main().catch(err => {
  console.error(`fatal: ${err.message}`);
  process.exit(1);
});
