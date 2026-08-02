// ══════════════════════════════════════════════════════════════════
//  VISA BYPASS — POST /api/proxy-request
//  Vercel serverless function
//
//  Relays a calendar API request through a rotating residential proxy
//  so each request exits from a FRESH IP — defeating Cloudflare's
//  per-IP rate limiting (HTTP 1015 / PSE0501 during rapid refreshes).
//
//  Security:
//   • License-gated — only valid license keys may use the relay
//     (protects your paid proxy bandwidth).
//   • Target URL allowlisted to usvisascheduling.com — prevents the
//     endpoint from being used as an open proxy.
//   • Per-license in-memory rate limit.
//
//  Proxy credentials come from env vars (set in Vercel dashboard):
//    PROXY_HOST  e.g. p.webshare.io  (residential gateway host)
//    PROXY_PORT  e.g. 80 or 31112
//    PROXY_USER  e.g. your-username-rotate  (rotation mode = new IP)
//    PROXY_PASS  e.g. your-password
// ══════════════════════════════════════════════════════════════════

const { ProxyAgent } = require('undici');
const { verifyLicense } = require('../lib/db');

// ── Config ────────────────────────────────────────────────────────

const ALLOWED_HOSTS = ['usvisascheduling.com'];
const MAX_BODY_BYTES = 2 * 1024 * 1024; // 2 MB response cap
const REQUEST_TIMEOUT_MS = 12000; // upstream request timeout
const RATE_LIMIT_PER_MIN = 120; // per license key
const MAX_ATTEMPTS = 3; // initial + 2 fresh-IP retries on CF challenge

// ── In-memory rate buckets (per license) ─────────────────────────
const rateBuckets = new Map();

function isRateLimited(key) {
  const now = Date.now();
  const bucket = rateBuckets.get(key) || { count: 0, windowStart: now };
  if (now - bucket.windowStart > 60000) {
    bucket.count = 0;
    bucket.windowStart = now;
  }
  bucket.count += 1;
  rateBuckets.set(key, bucket);
  return bucket.count > RATE_LIMIT_PER_MIN;
}

// ── Proxy URI from env vars ───────────────────────────────────────

function proxyUri() {
  const host = process.env.PROXY_HOST;
  if (!host) return null;
  const port = process.env.PROXY_PORT || '80';
  const user = process.env.PROXY_USER;
  const pass = process.env.PROXY_PASS || '';
  const auth = user ? `${encodeURIComponent(user)}:${encodeURIComponent(pass)}@` : '';
  return `http://${auth}${host}:${port}`;
}

// ── Target URL allowlist ──────────────────────────────────────────

function isAllowedTarget(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (_) {
    return false;
  }
  // HTTPS only + default port only — prevents probing non-standard
  // ports (or plaintext) on the allowlisted host.
  if (parsed.protocol !== 'https:') return false;
  if (parsed.port && parsed.port !== '443') return false;
  return ALLOWED_HOSTS.some(
    (h) => parsed.hostname === h || parsed.hostname.endsWith('.' + h)
  );
}

// ── Cloudflare challenge / rate-limit detector ────────────────────
//  Used to decide whether to rotate to a fresh proxy IP and retry.
function isCfChallenge(status, headers, bodyText) {
  if (status === 429) return true; // CF rate limit (1015) — new IP should fix
  if (status === 403) {
    const get = (k) =>
      String(
        (headers && (headers[k] || headers[k.toLowerCase()])) || ''
      ).toLowerCase();
    const mitigated = get('cf-mitigated');
    const server = get('server');
    const contentType = get('content-type');
    if (mitigated === 'challenge') return true;
    if (server === 'cloudflare') return true;
    if (contentType.includes('text/html')) return true;
    const lower = String(bodyText || '').toLowerCase();
    if (
      lower.includes('just a moment') ||
      lower.includes('cf-challenge') ||
      lower.includes('challenge-platform') ||
      lower.includes('cf-turnstile')
    ) {
      return true;
    }
    // 403 on these API endpoints is almost always Cloudflare
    return true;
  }
  return false;
}

// ── Handler ───────────────────────────────────────────────────────

module.exports = async (req, res) => {
  // CORS headers for extension background script
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, reason: 'method', error: 'Method not allowed' });
  }

  const { licenseKey, url, method = 'GET', headers = {}, body = null, cookies = '' } =
    req.body || {};

  // 1. License key present?
  if (!licenseKey || typeof licenseKey !== 'string') {
    return res.status(400).json({ ok: false, reason: 'license', error: 'License key required' });
  }

  // 2. Target URL valid + allowlisted?
  if (!url || typeof url !== 'string' || !isAllowedTarget(url)) {
    return res.status(400).json({ ok: false, reason: 'url', error: 'Invalid or disallowed target URL' });
  }

  const normalizedKey = licenseKey.trim().toUpperCase();

  // 3. License gate — verify against the license DB
  let license;
  try {
    license = await verifyLicense(normalizedKey);
  } catch (err) {
    console.error('proxy-request license check error:', err);
    return res.status(500).json({ ok: false, reason: 'server', error: 'License check failed' });
  }
  if (!license.valid) {
    return res.status(403).json({ ok: false, reason: 'license', error: license.error || 'Invalid license' });
  }

  // 4. Per-license rate limit
  if (isRateLimited(normalizedKey)) {
    return res.status(429).json({ ok: false, reason: 'ratelimit', error: 'Relay rate limit reached' });
  }

  // 5. Proxy configured?
  const uri = proxyUri();
  if (!uri) {
    return res
      .status(500)
      .json({ ok: false, reason: 'proxy', error: 'Proxy not configured on server (set PROXY_HOST etc.)' });
  }

  // 6. Build upstream request headers — pass caller headers through,
  //    re-inject the harvested session cookies, request plain body.
  const upstreamHeaders = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (!v) continue;
    const lk = String(k).toLowerCase();
    // Host/Content-Length are managed by the client; Cookie is re-added
    // below from the harvested session; identity avoids gzip issues.
    if (lk === 'host' || lk === 'content-length' || lk === 'cookie' || lk === 'accept-encoding') {
      continue;
    }
    upstreamHeaders[k] = String(v);
  }
  if (cookies) upstreamHeaders['Cookie'] = cookies;
  upstreamHeaders['Accept-Encoding'] = 'identity';
  upstreamHeaders['User-Agent'] =
    upstreamHeaders['User-Agent'] ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.127 Safari/537.36';

  // 7. Fire the request through the rotating proxy. Each attempt uses a
  //    FRESH ProxyAgent (fresh connection) so a rotating gateway assigns
  //    a new residential IP — if this IP is CF-challenged/rate-limited,
  //    we rotate and retry instead of failing the request.
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const attemptAgent = new ProxyAgent(uri);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const upstream = await fetch(url, {
        method,
        headers: upstreamHeaders,
        body: method === 'GET' || method === 'HEAD' ? undefined : body || undefined,
        redirect: 'manual',
        signal: controller.signal,
        dispatcher: attemptAgent,
      });

      const buffer = Buffer.from(await upstream.arrayBuffer());
      if (buffer.length > MAX_BODY_BYTES) {
        return res.status(413).json({ ok: false, reason: 'large', error: 'Response too large' });
      }

      const respHeaders = {};
      upstream.headers.forEach((v, k) => {
        respHeaders[k] = v;
      });
      const bodyText = buffer.toString('utf-8');

      // Still challenged/rate-limited and we have attempts left → rotate
      if (attempt < MAX_ATTEMPTS && isCfChallenge(upstream.status, respHeaders, bodyText)) {
        continue;
      }

      return res.json({
        ok: true,
        status: upstream.status,
        statusText: upstream.statusText || '',
        headers: respHeaders,
        body: bodyText,
      });
    } catch (err) {
      if (attempt === MAX_ATTEMPTS) {
        console.error('proxy-request upstream error:', err);
        return res.status(502).json({
          ok: false,
          reason: 'upstream',
          error: String((err && err.message) || err),
        });
      }
      // Network error — rotate to a fresh IP and retry
    } finally {
      clearTimeout(timer);
      try {
        attemptAgent.close();
      } catch (_) {}
    }
  }
};

// Allow the proxied round-trip more than the default 10s budget
module.exports.config = { maxDuration: 30 };

// Exposed for tests
module.exports.isCfChallenge = isCfChallenge;
