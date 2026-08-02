#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════════
//  VISA BYPASS — Local Rotation Bridge
// ══════════════════════════════════════════════════════════════════
//  A tiny forward proxy on your own machine that does the WebShare
//  login itself — so Chrome never needs to authenticate (that's what
//  breaks the browser-proxy approach: Chrome won't show the login
//  dialog for extension-set proxies, and the tunnel dies with
//  ERR_TUNNEL_CONNECTION_FAILED).
//
//  Flow:
//    Chrome (PAC → PROXY 127.0.0.1:8787)  →  this bridge
//                                          →  WebShare residential
//                                          →  target site
//
//  Rotation:
//    POST /rotate  →  bumps the session id → the NEXT new connection
//    exits from a NEW residential IP. The extension calls this the
//    moment it detects a 429 rate limit ("rotate on 429").
//
//  Run:    node local-bridge.js
//  Config: local-bridge-config.json (same folder — gitignored):
//    {
//      "gateway": "p.webshare.io",
//      "gatewayPort": 80,
//      "baseUser": "YOUR_USERNAME_WITHOUT_SUFFIX",
//      "pass": "YOUR_PASSWORD",
//      "mode": "session",          // 'session' (sticky IP, solve flow works)
//                                 //   or 'rotate' (new IP per connection)
//      "listenHost": "127.0.0.1",
//      "listenPort": 8787
//    }
//
//  Tips:
//    • mode 'session' is recommended — the challenge-tab solve flow
//      needs a stable IP per session; rotate on 429 via /rotate.
//    • mode 'rotate' gives a fresh IP per connection (no 429s) but
//      breaks captcha solving (IP changes between solve tab & retry).
// ══════════════════════════════════════════════════════════════════

'use strict';

const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');

// ── Config ────────────────────────────────────────────────────────
const CFG_PATH = path.join(__dirname, 'local-bridge-config.json');
let config;
try {
  config = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
} catch (err) {
  console.error('✗ Cannot read local-bridge-config.json:', err.message);
  console.error(
    '  Create it like: {"gateway":"p.webshare.io","gatewayPort":80,' +
      '"baseUser":"...","pass":"...","mode":"session","listenPort":8787}'
  );
  process.exit(1);
}

const LISTEN_HOST = config.listenHost || '127.0.0.1';
const LISTEN_PORT = config.listenPort || 8787;
const MODE = config.mode === 'rotate' ? 'rotate' : 'session';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.6478.127 Safari/537.36';

let sessionId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

function proxyUsername() {
  const base = config.baseUser || '';
  return MODE === 'rotate' ? base + '-rotate' : base + '-session-' + sessionId;
}

function proxyAuthHeader() {
  const user = proxyUsername();
  const pass = config.pass || '';
  return 'Basic ' + Buffer.from(user + ':' + pass).toString('base64');
}

function log(msg) {
  console.log('[' + new Date().toISOString().slice(11, 19) + '] ' + msg);
}

// ── CONNECT (HTTPS tunnels) ───────────────────────────────────────
function handleConnect(req, clientSocket, head) {
  const target = req.url; // "host:port"
  if (!target || !/^[a-zA-Z0-9.\-]+:\d+$/.test(target)) {
    clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return;
  }

  const upstream = net.connect(config.gatewayPort || 80, config.gateway);
  let responded = false;
  let buffer = Buffer.alloc(0);

  upstream.on('connect', () => {
    upstream.write(
      'CONNECT ' + target + ' HTTP/1.1\r\n' +
      'Host: ' + target + '\r\n' +
      'Proxy-Authorization: ' + proxyAuthHeader() + '\r\n' +
      'User-Agent: ' + UA + '\r\n' +
      '\r\n'
    );
  });

  upstream.on('data', (chunk) => {
    if (responded) return;
    buffer = Buffer.concat([buffer, chunk]);
    const endIdx = buffer.indexOf('\r\n\r\n');
    if (endIdx === -1) return;
    responded = true;

    const statusLine = buffer.toString('latin1', 0, buffer.indexOf('\r\n'));
    if (statusLine.includes(' 200')) {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      // Forward any early client bytes (TLS ClientHello) to upstream
      if (head && head.length) upstream.write(head);
      const rest = buffer.slice(endIdx + 4);
      if (rest.length) clientSocket.write(rest);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    } else {
      clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      clientSocket.end();
      upstream.destroy();
    }
  });

  upstream.on('error', () => {
    if (!responded) clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    clientSocket.destroy();
  });
  clientSocket.on('error', () => upstream.destroy());
}

// ── Plain HTTP / control endpoints ────────────────────────────────
function handleRequest(req, res) {
  // Control endpoints
  if (req.method === 'POST' && req.url === '/rotate') {
    sessionId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, mode: MODE, username: proxyUsername() }));
    log('↻ rotated → ' + proxyUsername());
    return;
  }
  if (req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        mode: MODE,
        username: proxyUsername(),
        sessionId: sessionId,
        listenHost: LISTEN_HOST,
        listenPort: LISTEN_PORT,
        gateway: config.gateway,
      })
    );
    return;
  }

  // Absolute-URI HTTP forward (non-tunnel)
  let target;
  try {
    target = new URL(req.url);
  } catch (_) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Bad request');
    return;
  }

  const headers = Object.assign({}, req.headers);
  delete headers['proxy-authorization'];
  headers['Host'] = target.host;
  headers['Proxy-Authorization'] = proxyAuthHeader();
  headers['User-Agent'] = headers['User-Agent'] || UA;

  const preq = http.request(
    {
      host: config.gateway,
      port: config.gatewayPort || 80,
      method: req.method,
      path: req.url, // absolute-URI (proxy style)
      headers: headers,
    },
    (pres) => {
      res.writeHead(pres.statusCode, pres.headers);
      pres.pipe(res);
    }
  );
  preq.on('error', () => {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('Upstream error');
  });
  req.pipe(preq);
}

// ── Server ────────────────────────────────────────────────────────
const server = http.createServer(handleRequest);
server.on('connect', handleConnect);

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  log('✓ Local rotation bridge on ' + LISTEN_HOST + ':' + LISTEN_PORT);
  log('  mode=' + MODE + ' username=' + proxyUsername());
  log('  Set extension IP Rotation → host 127.0.0.1, port ' + LISTEN_PORT);
  log('  POST /rotate = new IP  |  GET /status = inspect');
});

process.on('SIGINT', () => {
  log('bye');
  process.exit(0);
});
