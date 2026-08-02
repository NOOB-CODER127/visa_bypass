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
//  Locate the config next to the executable when packaged (the exe's
//  __dirname points inside the bundle), otherwise next to the script.
function resolveConfigPath() {
  try {
    const exeDir = path.dirname(process.execPath);
    const exeCfg = path.join(exeDir, 'local-bridge-config.json');
    if (fs.existsSync(exeCfg)) return exeCfg;
  } catch (_) {}
  return path.join(__dirname, 'local-bridge-config.json');
}

const CFG_PATH = resolveConfigPath();
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

// ── License-gated authorization ───────────────────────────────────
//  When authRequired is true (VPS deployments), only client IPs whose
//  extension has presented a VALID license key (POST /auth) may open
//  tunnels. The extension re-authorizes every ~8 min; the whitelist
//  TTL is 10 min. This stops strangers from using the box as an open
//  relay (bandwidth abuse / credential theft).
const AUTH_REQUIRED = config.authRequired === true;
const LICENSE_SERVER = config.licenseServer || 'https://visa-bypass.vercel.app';
const AUTH_TTL_MS = 10 * 60 * 1000;
const authorizedIps = new Map(); // ip -> expiresAt (ms)

function clientIp(socket) {
  return String((socket && socket.remoteAddress) || '').replace(/^::ffff:/, '');
}

function isAuthorized(socket) {
  if (!AUTH_REQUIRED) return true;
  const ip = clientIp(socket);
  const exp = authorizedIps.get(ip) || 0;
  if (Date.now() < exp) return true;
  authorizedIps.delete(ip);
  return false;
}

// Drop expired entries so the map can't grow forever.
setInterval(() => {
  const now = Date.now();
  for (const [ip, exp] of authorizedIps) {
    if (now >= exp) authorizedIps.delete(ip);
  }
}, AUTH_TTL_MS).unref();

// ── CONNECT (HTTPS tunnels) ───────────────────────────────────────
//  Tunnels are tracked so POST /rotate can destroy them — in rotate
//  mode the pool assigns an IP per NEW connection, and the browser
//  reuses its open tunnels (keep-alive), which pins the old IP. Dropping
//  the tunnels forces the browser to open fresh connections → fresh IPs.
const activeTunnels = new Set();

function handleConnect(req, clientSocket, head) {
  const target = req.url; // "host:port"
  if (!target || !/^[a-zA-Z0-9.\-]+:\d+$/.test(target)) {
    clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return;
  }
  if (!isAuthorized(clientSocket)) {
    clientSocket.end(
      'HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n\r\n' +
        'Unauthorized: activate a license in the Visa Bypass extension.'
    );
    log('⛔ tunnel denied from ' + clientIp(clientSocket));
    return;
  }

  const upstream = net.connect(config.gatewayPort || 80, config.gateway);
  let responded = false;
  let buffer = Buffer.alloc(0);

  activeTunnels.add(clientSocket);
  activeTunnels.add(upstream);
  const untrack = () => {
    activeTunnels.delete(clientSocket);
    activeTunnels.delete(upstream);
  };
  clientSocket.on('close', untrack);
  upstream.on('close', untrack);

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
  if (req.method === 'POST' && req.url === '/auth') {
    // License-gated authorization: the extension posts its license key;
    // on success we whitelist the requester's IP for AUTH_TTL_MS.
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 1024) req.destroy();
    });
    req.on('end', () => {
      let key = '';
      try {
        key = String((JSON.parse(body).licenseKey || '')).trim().toUpperCase();
      } catch (_) {}
      if (!key) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'licenseKey required' }));
        return;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      fetch(LICENSE_SERVER + '/api/verify-license', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ licenseKey: key }),
        signal: controller.signal,
      })
        .then((r) => r.json())
        .then((data) => {
          clearTimeout(timer);
          if (data && data.valid === true) {
            const ip = clientIp(req.socket);
            authorizedIps.set(ip, Date.now() + AUTH_TTL_MS);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, ip: ip, ttlSec: AUTH_TTL_MS / 1000 }));
            log('🔑 authorized ' + ip);
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'invalid license' }));
            log('✗ auth rejected from ' + clientIp(req.socket));
          }
        })
        .catch(() => {
          clearTimeout(timer);
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'license server unreachable' }));
        });
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/rotate') {
    if (!isAuthorized(req.socket)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
      return;
    }
    sessionId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    // Destroy all live tunnels: the NEXT connection must be brand new,
    // so the proxy pool assigns a fresh IP (the actual IP change in
    // rotate mode). The browser transparently reconnects.
    const closed = activeTunnels.size;
    for (const s of activeTunnels) {
      try { s.destroy(); } catch (_) {}
    }
    activeTunnels.clear();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, mode: MODE, username: proxyUsername(), closedTunnels: closed }));
    log('↻ rotated → ' + proxyUsername() + (closed ? ' (closed ' + closed + ' tunnel(s))' : ''));
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
        authRequired: AUTH_REQUIRED,
        authorizedClients: AUTH_REQUIRED ? authorizedIps.size : 0,
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
  log('  authRequired=' + AUTH_REQUIRED + (AUTH_REQUIRED ? ' (license-gated tunnels)' : ''));
  log('  Set extension IP Rotation → host ' + LISTEN_HOST + ', port ' + LISTEN_PORT);
  log('  POST /auth = authorize  |  POST /rotate = new IP  |  GET /status = inspect');
});

process.on('SIGINT', () => {
  log('bye');
  process.exit(0);
});
