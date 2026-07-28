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

// ── License Verification (server-side, cached) ────────────────────
// License is NOT cached in storage — every interception re-checks
// with the server.  In-memory cache with 5-minute TTL reduces
// redundant calls while keeping tampering window very small.

const LICENSE_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

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
      expiresAt: now + LICENSE_CACHE_TTL,
    };
    return serverResult.valid;
  } catch (_) {
    // Server unreachable — use stale cache or default to invalid
    if (now < licenseCache.expiresAt) return licenseCache.valid;
    licenseCache = { valid: false, key: null, expiresAt: now + LICENSE_CACHE_TTL };
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
}

init().catch(() => {});

// ── Message Handler ───────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender) => {
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
      const [enabledResult] = await Promise.all([
        chrome.storage.local.get(['enabled']),
      ]);
      const isValid = await checkLicenseServer();
      chrome.runtime.sendMessage({
        type: 'VISA_STATUS',
        enabled: enabledResult.enabled !== false,
        licensed: isValid,
      });
    })();
  }

  if (message.type === 'VISA_ACTIVATE_LICENSE') {
    handleActivateLicense(message);
  }

  // Intercepted: respond with server-verified status
  if (message.type === 'VISA_GET_LICENSE_STATUS') {
    (async () => {
      const isValid = await checkLicenseServer();
      chrome.runtime.sendMessage({
        type: 'VISA_LICENSE_STATUS',
        valid: isValid,
      });
    })();
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

// ── Open CF Solve Tab ─────────────────────────────────────────────

async function handleOpenCfTab(message, sender) {
  const sourceTabId = sender.tab?.id;
  if (!sourceTabId) return;

  // ═════════════════════════════════════════════════════════════════
  //  SERVER-SIDE LICENSE CHECK (every interception)
  //  No local 'verified' flag is trusted. The stored license key
  //  is verified with the server every time (cached in memory with
  //  5-min TTL to avoid hammering). If the server is unreachable,
  //  the license is treated as invalid — no bypass without server.
  // ═════════════════════════════════════════════════════════════════
  const isValid = await checkLicenseServer();
  if (!isValid) {
    chrome.tabs
      .sendMessage(sourceTabId, {
        type: 'VISA_LICENSE_FAILED',
        error: 'License invalid or expired — please activate a valid key in the extension popup.',
      })
      .catch(() => {});
    return;
  }

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
