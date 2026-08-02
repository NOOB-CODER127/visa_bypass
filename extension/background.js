// ══════════════════════════════════════════════════════════════════
//  VISA BYPASS — Background Service Worker
// ══════════════════════════════════════════════════════════════════
//
//  Uses chrome.storage.session to persist pending state across
//  service worker restarts (MV3 kills SW after ~30s inactivity).
//
//  Flow:
//    1. Content script sends VISA_OPEN_CF_TAB with blockedUrl
//    2. SW opens a new tab to the blocked API URL (guarantees CF Turnstile)
//    3. Stores pending state in chrome.storage.session
//    4. When user closes the solve tab → VISA_CF_TAB_CLOSED fires
//    5. Content script posts VISA_CONTINUE_REQUEST → inject.js retries
// ══════════════════════════════════════════════════════════════════

// ── Configuration ─────────────────────────────────────────────────
// Dev: Set to 'http://localhost:3000'
//
const LICENSE_SERVER_URL = 'https://visa-bypass.vercel.app';
const STORAGE_KEY = 'pendingVisaSolve';
const COOKIE_NAME = 'cf_clearance';
const RELAY_TIMEOUT_MS = 28000; // relay round-trip timeout (server may retry on fresh IPs: 3×8s)

// ── License Verification (server-side, cached) ────────────────────
// License is only used for the popup status display and activation.
// It does NOT gate the CF-bypass interception flow — that runs for
// everyone.  In-memory cache with 5-minute TTL reduces redundant
// calls.

const LICENSE_CACHE_TTL = 5 * 60 * 1000; // 5 minutes for success
const LICENSE_FAILURE_TTL = 30 * 1000; // 30 seconds for failures

let lastBlockPageHandledAt = 0; // dedupe for VISA_CF_BLOCK_PAGE

let licenseCache = {
  valid: false,
  key: null,
  expiresAt: 0,
};

async function verifyLicense(licenseKey) {
  try {
    const response = await fetch(`${LICENSE_SERVER_URL}/api/verify-license`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ licenseKey: licenseKey.trim().toUpperCase() }),
    });
    return await response.json();
  } catch (err) {
    return { valid: false, error: 'Cannot reach license server. Check your connection.' };
  }
}

async function checkLicenseServer() {
  const now = Date.now();

  // Return cached result if still fresh
  if (now < licenseCache.expiresAt) {
    return licenseCache.valid;
  }

  // Look up stored license key
  const result = await chrome.storage.local.get(['license']);
  const key = result.license?.key;
  if (!key) {
    licenseCache = { valid: false, key: null, expiresAt: now + LICENSE_CACHE_TTL };
    return false;
  }

  try {
    const serverResult = await verifyLicense(key);
    licenseCache = {
      valid: serverResult.valid,
      key: key,
      expiresAt: now + (serverResult.valid ? LICENSE_CACHE_TTL : LICENSE_FAILURE_TTL),
    };
    return serverResult.valid;
  } catch (_) {
    // Server unreachable — use stale cache or default to invalid
    if (now < licenseCache.expiresAt) return licenseCache.valid;
    licenseCache = { valid: false, key: null, expiresAt: now + LICENSE_FAILURE_TTL };
    return false;
  }
}

// ── Logout Alert ──────────────────────────────────────────────────

function notifyLogout() {
  if (!chrome.notifications) return;
  chrome.notifications
    .create('visa-logout-alert', {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'Visa Bypass — Logged out',
      message:
        'Your session on usvisascheduling.com has expired. Please log in again.',
      priority: 2,
    })
    .catch(() => {});
}

// ── Software VPN (Browser Proxy) ─────────────────────────────────
//  Routes the REAL browser's usvisascheduling.com traffic through a
//  rotating residential proxy (chrome.proxy + PAC) — a software VPN.
//  A real browser has a genuine TLS fingerprint, so Cloudflare rarely
//  challenges it (unlike the server-side relay's HTTP client, which
//  gets challenged on every fresh IP).
//
//  Auth: MV3 cannot inject proxy credentials (onAuthRequired is
//  enterprise-only, and Chrome ignores credentials inside PAC
//  scripts — verified). The browser shows an auth dialog ONCE per
//  session; the user enters their WebShare username (use -session-XXXX
//  for a sticky IP) + password. IP rotation happens via the WebShare
//  session duration setting.

// Recommended default: the local rotation bridge (no login dialog).
const DEFAULT_VPN_HOST = '127.0.0.1';
const DEFAULT_VPN_PORT = '8787';

// Local rotation bridge (local-bridge.js) — Chrome talks to localhost
// (or the configured VPS) so no proxy login dialog is needed; the
// bridge does the WebShare auth and rotates IPs. POST /rotate drops the
// bridge's live tunnels so the next connection gets a fresh IP from the
// pool. The bridge's host/port come from the IP Rotation settings.
async function getBridgeTarget() {
  const st = await chrome.storage.local.get(['vpnHost', 'vpnPort']);
  return {
    host: st.vpnHost || DEFAULT_VPN_HOST,
    port: st.vpnPort || DEFAULT_VPN_PORT,
  };
}

async function notifyBridgeRotate() {
  try {
    const { host, port } = await getBridgeTarget();
    const resp = await fetch('http://' + host + ':' + port + '/rotate', {
      method: 'POST',
    });
    return resp.ok;
  } catch (_) {
    return false; // Bridge not running — nothing to rotate.
  }
}

// Authorize this client with the bridge (license-gated VPS
// deployments). The bridge whitelists our IP for 10 min; we refresh
// every ~8 min so tunnels keep flowing. No-op when the bridge is
// offline or no license is stored.
async function bridgeAuth() {
  try {
    const result = await chrome.storage.local.get(['license']);
    const key = result.license && result.license.key;
    if (!key) return false;
    const { host, port } = await getBridgeTarget();
    const resp = await fetch('http://' + host + ':' + port + '/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ licenseKey: key }),
    });
    const data = await resp.json().catch(() => null);
    return !!(data && data.ok === true);
  } catch (_) {
    return false;
  }
}

// MV3 service workers are suspended after ~30s idle and setInterval does
// NOT fire while suspended — so the license re-auth uses chrome.alarms,
// which wakes the SW reliably. Keep the bridge TTL (10 min) > period
// (8 min) so a client's tunnels never expire between refreshes.
const BRIDGE_AUTH_ALARM = 'visa-bridge-auth';

function buildPacScript(host, port) {
  const h = String(host || '').trim();
  const p = String(port || '80').trim();
  return (
    'function FindProxyForURL(url, host) {' +
    '  if (dnsDomainIs(host, "usvisascheduling.com")) {' +
    (h ? '    return "PROXY ' + h + ':' + p + '";' : '    return "DIRECT";') +
    '  }' +
    '  return "DIRECT";' +
    '}'
  );
}

async function applyBrowserProxy(enable) {
  try {
    if (!enable) {
      await chrome.proxy.settings.set({
        value: { mode: 'direct' },
        scope: 'regular',
      });
      return true;
    }
    const stored = await chrome.storage.local.get(['vpnHost', 'vpnPort']);
    const pac = buildPacScript(
      stored.vpnHost || DEFAULT_VPN_HOST,
      stored.vpnPort || DEFAULT_VPN_PORT
    );
    await chrome.proxy.settings.set({
      value: { mode: 'pac_script', pacScript: { data: pac } },
      scope: 'regular',
    });
    return true;
  } catch (err) {
    console.error('Visa Bypass: applyBrowserProxy error:', err);
    return false;
  }
}

// ── Initialize: check stored license on startup ───────────────────
async function init() {
  // Check for stale pending requests
  const pendingData = await chrome.storage.session.get(STORAGE_KEY);
  if (pendingData[STORAGE_KEY]) {
    try {
      const tab = await chrome.tabs.get(pendingData[STORAGE_KEY].solveTabId);
      if (tab) return;
    } catch (_) {
      await chrome.storage.session.remove(STORAGE_KEY);
    }
  }

  // Re-assert the browser proxy if the Software VPN is enabled
  const st = await chrome.storage.local.get(['vpn']);
  if (st.vpn === true) {
    applyBrowserProxy(true).catch(() => {});
    // Keep the bridge authorization fresh (license-gated VPS tunnels).
    // chrome.alarms (not setInterval) — it fires even when the SW is
    // suspended, so a client's tunnels never hit the 10-min TTL.
    bridgeAuth().catch(() => {});
    chrome.alarms.create(BRIDGE_AUTH_ALARM, { periodInMinutes: 8 }).catch(() => {});
  }
}

init().catch(() => {});

// ── Message Handler ───────────────────────────────────────────────

// ── Bridge auth refresh (chrome.alarms — fires even when the SW is
//    suspended, unlike setInterval in MV3) ─────────────────────────
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm && alarm.name === BRIDGE_AUTH_ALARM) {
    bridgeAuth().catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'VISA_OPEN_CF_TAB') {
    handleOpenCfTab(message, sender);
  }

  if (message.type === 'VISA_TOGGLE') {
    chrome.storage.local.set({ enabled: message.enabled });
    chrome.tabs
      .query({ url: '*://*.usvisascheduling.com/*' })
      .then((tabs) => {
        tabs.forEach((tab) => {
          chrome.tabs
            .sendMessage(tab.id, { type: 'VISA_STATUS_CHANGE', enabled: message.enabled })
            .catch(() => {});
        });
      });
  }

  if (message.type === 'VISA_GET_STATUS') {
    (async () => {
      // Re-auth with the bridge whenever the popup opens (cheap, keeps
      // tunnels from expiring even if alarms were somehow missed).
      bridgeAuth().catch(() => {});
      // Verify the license FIRST (network call, can take 1-2s), then
      // read the toggle states AFTER — so the VISA_STATUS response always
      // reflects the CURRENT storage, not a stale snapshot. Reading
      // storage before the await let the user's toggle changes race with
      // the delayed response, snapping toggles (e.g. Proxy Relay) back OFF.
      const isValid = await checkLicenseServer();
      const [
        enabledResult,
        keepAliveResult,
        relayResult,
        vpnResult,
        vpnCfgResult,
      ] = await Promise.all([
        chrome.storage.local.get(['enabled']),
        chrome.storage.local.get(['keepAlive']),
        chrome.storage.local.get(['relay']),
        chrome.storage.local.get(['vpn']),
        chrome.storage.local.get(['vpnHost', 'vpnPort']),
      ]);
      chrome.runtime.sendMessage({
        type: 'VISA_STATUS',
        enabled: enabledResult.enabled !== false,
        keepAlive: keepAliveResult.keepAlive !== false,
        relay: relayResult.relay === true,
        vpn: vpnResult.vpn === true,
        vpnHost: vpnCfgResult.vpnHost || DEFAULT_VPN_HOST,
        vpnPort: vpnCfgResult.vpnPort || DEFAULT_VPN_PORT,
        licensed: isValid,
      });
    })();
  }

  if (message.type === 'VISA_LOGOUT_DETECTED') {
    // Session expired or user was redirected to the login page
    notifyLogout();
  }

  if (message.type === 'VISA_KEEP_ALIVE_TOGGLE') {
    chrome.storage.local.set({ keepAlive: message.enabled });
    chrome.tabs
      .query({ url: '*://*.usvisascheduling.com/*' })
      .then((tabs) => {
        tabs.forEach((tab) => {
          chrome.tabs
            .sendMessage(tab.id, {
              type: 'VISA_KEEP_ALIVE_CHANGE',
              enabled: message.enabled,
            })
            .catch(() => {});
        });
      });
  }

  if (message.type === 'VISA_RELAY_TOGGLE') {
    chrome.storage.local.set({ relay: message.enabled === true });
    chrome.tabs
      .query({ url: '*://*.usvisascheduling.com/*' })
      .then((tabs) => {
        tabs.forEach((tab) => {
          chrome.tabs
            .sendMessage(tab.id, { type: 'VISA_RELAY_CHANGE', enabled: message.enabled === true })
            .catch(() => {});
        });
      });
  }

  if (message.type === 'VISA_VPN_TOGGLE') {
    (async () => {
      const enabled = message.enabled === true;
      const ok = await applyBrowserProxy(enabled);
      if (ok) await chrome.storage.local.set({ vpn: enabled });
      if (ok) {
        if (enabled) {
          bridgeAuth().catch(() => {});
          chrome.alarms.create(BRIDGE_AUTH_ALARM, { periodInMinutes: 8 }).catch(() => {});
        } else {
          chrome.alarms.clear(BRIDGE_AUTH_ALARM).catch(() => {});
        }
      }
      sendResponse({ ok, enabled });
    })();
    return true; // async response
  }

  if (message.type === 'VISA_VPN_SAVE') {
    (async () => {
      const host = String(message.host || '').trim();
      const port = String(message.port || '80').trim();
      // Sanitize — the PAC script is evaluated as JS, so host/port must
      // be strictly constrained to avoid script injection.
      if (!/^[a-zA-Z0-9.\-]+$/.test(host) || !/^\d+$/.test(port)) {
        sendResponse({ ok: false, error: 'Invalid host or port' });
        return;
      }
      await chrome.storage.local.set({ vpnHost: host, vpnPort: port });
      // If the VPN is currently ON, re-apply with the new settings
      const st = await chrome.storage.local.get(['vpn']);
      let reapplyOk = true;
      if (st.vpn === true) reapplyOk = await applyBrowserProxy(true);
      sendResponse({ ok: reapplyOk });
    })();
    return true; // async response
  }

  if (message.type === 'VISA_ROTATE_REQUEST') {
    // Fire-and-forget: tell the local bridge to switch to a fresh IP.
    notifyBridgeRotate();
  }

  if (message.type === 'VISA_CHANGE_IP') {
    // Manual "Change IP" from the popup: re-authorize, rotate the bridge
    // (drops its tunnels so the browser must open fresh connections →
    // fresh IPs), then reload every visa tab so they all re-connect on a
    // new IP. Reports whether the bridge was actually reached.
    (async () => {
      await bridgeAuth();
      const rotated = await notifyBridgeRotate();
      await new Promise((r) => setTimeout(r, 600));
      const tabs = await chrome.tabs.query({ url: '*://*.usvisascheduling.com/*' });
      for (const t of tabs) {
        if (t.id) chrome.tabs.reload(t.id).catch(() => {});
      }
      sendResponse({ ok: rotated });
    })();
    return true; // async response
  }

  if (message.type === 'VISA_CF_BLOCK_PAGE') {
    // Cloudflare WAF served a hard block page (usually caused by a
    // stale cf_clearance from a previous proxy IP). Drop stale tunnels
    // (fresh IP on next connection) + purge CF-owned cookies, then
    // reload so the page loads clean.
    // Dedupe: the source tab and the solve tab can both report a block
    // within the same second — one purge+reload round is enough.
    const now = Date.now();
    if (now - lastBlockPageHandledAt < 10 * 1000) return;
    lastBlockPageHandledAt = now;
    bridgeAuth()
      .then(notifyBridgeRotate)
      .then(clearCfCookies)
      .finally(() => {
        if (sender.tab && sender.tab.id) {
          chrome.tabs.reload(sender.tab.id).catch(() => {});
        }
      });
  }

  if (message.type === 'VISA_ACTIVATE_LICENSE') {
    handleActivateLicense(message);
  }

  if (message.type === 'VISA_RELAY_REQUEST') {
    handleRelayRequest(message)
      .then(sendResponse)
      .catch((err) =>
        sendResponse({ ok: false, reason: 'error', error: String((err && err.message) || err) })
      );
    return true; // async response
  }

  if (message.type === 'VISA_DEACTIVATE_LICENSE') {
    // Immediately invalidate in-memory cache AND clear storage
    // Note: popup already updates its own UI on click — no response needed
    licenseCache = { valid: false, key: null, expiresAt: 0 };
    chrome.storage.local.remove('license').catch(() => {});
  }
});

// ── License Activation ─────────────────────────────────────────────

async function handleActivateLicense(message) {
  const result = await verifyLicense(message.licenseKey);

  if (result.valid) {
    // Store license KEY only (no 'verified' flag — trust is server-side)
    await chrome.storage.local.set({
      license: {
        key: message.licenseKey.trim().toUpperCase(),
        expiresAt: result.expiresAt,
        activatedAt: new Date().toISOString(),
        features: result.features || ['basic'],
      },
    });

    // Invalidate cache so next checkLicenseServer() re-fetches
    licenseCache = { valid: true, key: message.licenseKey.trim().toUpperCase(), expiresAt: Date.now() + LICENSE_CACHE_TTL };

    // Authorize this client with the bridge (license-gated VPS tunnels)
    bridgeAuth().catch(() => {});

    // Notify popup
    chrome.runtime.sendMessage({
      type: 'VISA_LICENSE_STATUS',
      valid: true,
      expiresAt: result.expiresAt,
    });
  } else {
    chrome.runtime.sendMessage({
      type: 'VISA_LICENSE_STATUS',
      valid: false,
      error: result.error || 'Invalid license key',
    });
  }
}

// ── Proxy Relay Request ──────────────────────────────────────────
//  Routes a calendar API request through the license server, which
//  re-issues it via a rotating residential proxy (fresh IP each time)
//  to defeat Cloudflare per-IP rate limiting.

async function handleRelayRequest(message) {
  // License gate: a stored key is required (server re-verifies it).
  const result = await chrome.storage.local.get(['license']);
  const key = result.license?.key;
  if (!key) {
    return { ok: false, reason: 'license', error: 'Proxy relay requires a license' };
  }

  // Harvest the portal's SESSION cookies only. chrome.cookies reads
  // HttpOnly cookies too. Partitioned (CHIPS) cookies are skipped —
  // they are keyed to the top-level site and cannot be relayed.
  //
  // CRITICAL: Cloudflare-owned cookies are STRIPPED:
  //   • cf_clearance is bound to the browser's IP — it is invalid from
  //     a proxy IP, so sending it just looks like a failed clearance.
  //   • __cf_bm / cf_chl_* / __cfwaitingroom are bound to the browser's
  //     fingerprint/queue — replaying them from a different IP is an
  //     anomalous signal that can trigger more challenges/rate limits.
  let cookieHeader = '';
  try {
    const all = await chrome.cookies.getAll({});
    cookieHeader = all
      .filter(
        (c) =>
          c.domain &&
          c.domain.endsWith('usvisascheduling.com') &&
          !c.partitionKey &&
          !isCfOwnedCookie(c.name)
      )
      .map((c) => c.name + '=' + c.value)
      .join('; ');
  } catch (_) {}

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RELAY_TIMEOUT_MS);

  try {
    const resp = await fetch(LICENSE_SERVER_URL + '/api/proxy-request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        licenseKey: key,
        url: message.url,
        method: message.method || 'GET',
        headers: message.headers || {},
        body: message.body || null,
        cookies: cookieHeader,
      }),
      signal: controller.signal,
    });
    return await resp.json();
  } catch (err) {
    return { ok: false, reason: 'server', error: String((err && err.message) || err) };
  } finally {
    clearTimeout(timer);
  }
}

// ── Cloudflare cookie filter ──────────────────────────────────────
//  Returns true for Cloudflare-managed cookies that must NOT be
//  forwarded through the relay (they are IP/fingerprint-bound).
function isCfOwnedCookie(name) {
  const n = String(name || '').toLowerCase();
  return n.startsWith('cf_') || n.startsWith('__cf');
}

// ── Clear Cloudflare-owned cookies (block-page recovery) ──────────
//  cf_clearance / __cf_bm / __cfwaitingroom are bound to the IP that
//  minted them. Behind a rotating proxy they are always stale and can
//  trigger a hard WAF block ("Sorry, you have been blocked"). Purge
//  them so the next request starts clean.
async function clearCfCookies() {
  try {
    const all = await chrome.cookies.getAll({});
    const targets = all.filter(
      (c) =>
        c.domain &&
        c.domain.includes('usvisascheduling.com') &&
        isCfOwnedCookie(c.name)
    );
    for (const c of targets) {
      try {
        const url = 'https://' + c.domain.replace(/^\./, '') + (c.path || '/');
        const opts = { url, name: c.name };
        // Partitioned (CHIPS) cookies need their top-level site to remove.
        if (c.partitionKey) {
          opts.partitionKey = { topLevelSite: c.partitionKey };
        }
        await chrome.cookies.remove(opts);
      } catch (_) {}
    }
  } catch (_) {}
}

// ── Open CF Solve Tab ─────────────────────────────────────────────

async function handleOpenCfTab(message, sender) {
  const sourceTabId = sender.tab?.id;
  if (!sourceTabId) return;

  // NOTE: No server-side license gate here. The CF-bypass flow runs
  // for everyone — license status is display-only in the popup.
  const blockedUrl = message.blockedUrl || 'https://www.usvisascheduling.com/en-US/';

  // Open the PORTAL MAIN PAGE in the solve tab — NOT the raw API URL.
  // Navigating directly to a calendar API URL (a custom-actions route)
  // returns {"Message":"Action method not found"} instead of a captcha,
  // because those routes are POST-only. The main page reliably triggers
  // the CF Turnstile challenge; after solving, the IP-bound cf_clearance
  // lets the retried request succeed.
  let portalUrl = 'https://www.usvisascheduling.com/en-US/';
  try {
    portalUrl = new URL(blockedUrl).origin + '/en-US/';
  } catch (_) {}

  try {
    const tab = await chrome.tabs.create({ url: portalUrl, active: true });

    await chrome.storage.session.set({
      [STORAGE_KEY]: {
        sourceTabId,
        solveTabId: tab.id,
        blockedUrl,
        portalUrl,
        createdAt: Date.now(),
      },
    });
  } catch (err) {
    chrome.tabs
      .sendMessage(sourceTabId, {
        type: 'VISA_CF_SOLVE_ERROR',
        error: 'Could not open challenge tab: ' + err.message,
      })
      .catch(() => {});
  }
}

// ── Tab Close Detection ──────────────────────────────────────────

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const data = await chrome.storage.session.get(STORAGE_KEY);
  const pending = data[STORAGE_KEY];
  if (!pending || tabId !== pending.solveTabId) return;

  chrome.tabs
    .sendMessage(pending.sourceTabId, { type: 'VISA_CF_TAB_CLOSED' })
    .catch(() => {});

  await chrome.storage.session.remove(STORAGE_KEY);
});

// ── Cookie Monitor ────────────────────────────────────────────────

chrome.cookies.onChanged.addListener(async (changeInfo) => {
  if (
    !changeInfo.cookie ||
    changeInfo.cookie.name !== COOKIE_NAME ||
    !changeInfo.cookie.domain ||
    !changeInfo.cookie.domain.includes('usvisascheduling.com') ||
    changeInfo.removed
  ) {
    return;
  }

  const data = await chrome.storage.session.get(STORAGE_KEY);
  const pending = data[STORAGE_KEY];
  if (!pending) return;

  chrome.tabs
    .sendMessage(pending.sourceTabId, { type: 'VISA_CF_SOLVED' })
    .catch(() => {});

  try {
    const tab = await chrome.tabs.get(pending.solveTabId);
    if (tab && tab.id) chrome.tabs.remove(tab.id);
  } catch (_) {}

  await chrome.storage.session.remove(STORAGE_KEY);
});
