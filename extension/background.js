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
// Production: Set to your domain (e.g. 'https://suwate26.com')
// Dev: Set to 'http://localhost:3000'
//
// ⚠  Deployment options:
//
//   Option A — Vercel (recommended):
//     1. Push repo to GitHub
//     2. Import into Vercel → set root dir to 'server'
//     3. Create a Postgres database in Vercel Storage
//     4. Link DB to project (env vars auto-injected)
//     5. Set ADMIN_PASSWORD env var → deploy
//     6. Get URL like https://visa-bypass.vercel.app
//     7. Set up custom domain suwate26.com in Vercel dashboard
//     8. Update this URL to 'https://suwate26.com'
//
//   Option B — Render (alternative):
//     1. Deploy server to Render → get https://your-app.onrender.com
//     2. Set up custom domain (suwate26.com) on Render
//     3. Update this URL to 'https://suwate26.com'
//
const LICENSE_SERVER_URL = 'https://suwate26.com';
const STORAGE_KEY = 'pendingVisaSolve';
const COOKIE_NAME = 'cf_clearance';

// ── License Verification ───────────────────────────────────────────

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

async function broadcastLicenseStatus(licensed) {
  const tabs = await chrome.tabs.query({ url: '*://*.usvisascheduling.com/*' });
  tabs.forEach((tab) => {
    chrome.tabs.sendMessage(tab.id, { type: 'VISA_LICENSE_CHANGE', licensed }).catch(() => {});
  });
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
    Promise.all([
      chrome.storage.local.get(['enabled']),
      chrome.storage.local.get(['license']),
    ]).then(([enabledResult, licenseResult]) => {
      chrome.runtime.sendMessage({
        type: 'VISA_STATUS',
        enabled: enabledResult.enabled !== false,
        licensed: !!(licenseResult.license && licenseResult.license.verified),
        licenseInfo: licenseResult.license || null,
      });
    });
  }

  if (message.type === 'VISA_ACTIVATE_LICENSE') {
    handleActivateLicense(message);
  }
});

// ── License Activation ─────────────────────────────────────────────

async function handleActivateLicense(message) {
  const result = await verifyLicense(message.licenseKey);

  if (result.valid) {
    // Store verified license
    await chrome.storage.local.set({
      license: {
        verified: true,
        key: message.licenseKey.trim().toUpperCase(),
        expiresAt: result.expiresAt,
        activatedAt: new Date().toISOString(),
        features: result.features || ['basic'],
      },
    });

    // Notify popup
    chrome.runtime.sendMessage({
      type: 'VISA_LICENSE_STATUS',
      valid: true,
      expiresAt: result.expiresAt,
    });

    // Notify all open tabs
    broadcastLicenseStatus(true);
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

  const blockedUrl = message.blockedUrl || 'https://www.usvisascheduling.com/en-US/';

  // Check if cf_clearance already exists
  try {
    const cookie = await chrome.cookies.get({ url: blockedUrl, name: COOKIE_NAME });
    if (cookie && cookie.value) {
      chrome.tabs.sendMessage(sourceTabId, { type: 'VISA_CF_SOLVED' }).catch(() => {});
      return;
    }
  } catch (_) {}

  // Open a new tab to the blocked API URL
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
