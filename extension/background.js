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
}

init().catch(() => {});

// ── Message Handler ───────────────────────────────────────────────

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
      const [enabledResult, keepAliveResult, relayResult] = await Promise.all([
        chrome.storage.local.get(['enabled']),
        chrome.storage.local.get(['keepAlive']),
        chrome.storage.local.get(['relay']),
      ]);
      const isValid = await checkLicenseServer();
      chrome.runtime.sendMessage({
        type: 'VISA_STATUS',
        enabled: enabledResult.enabled !== false,
        keepAlive: keepAliveResult.keepAlive !== false,
        relay: relayResult.relay === true,
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

  // Harvest the portal's session cookies. chrome.cookies reads
  // HttpOnly cookies too. Partitioned (CHIPS) cookies are skipped —
  // they are keyed to the top-level site and cannot be relayed.
  let cookieHeader = '';
  try {
    const all = await chrome.cookies.getAll({});
    cookieHeader = all
      .filter(
        (c) =>
          c.domain &&
          c.domain.endsWith('usvisascheduling.com') &&
          !c.partitionKey
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

// ── Open CF Solve Tab ─────────────────────────────────────────────

async function handleOpenCfTab(message, sender) {
  const sourceTabId = sender.tab?.id;
  if (!sourceTabId) return;

  // NOTE: No server-side license gate here. The CF-bypass flow runs
  // for everyone — license status is display-only in the popup.
  const blockedUrl = message.blockedUrl || 'https://www.usvisascheduling.com/en-US/';

  // Open a new tab directly to the blocked API URL
  // This forces a real CF Turnstile challenge, ensuring the cookie
  // is fresh — no stale cf_clearance pre-check.
  try {
    const tab = await chrome.tabs.create({ url: blockedUrl, active: true });

    await chrome.storage.session.set({
      [STORAGE_KEY]: {
        sourceTabId,
        solveTabId: tab.id,
        blockedUrl,
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
