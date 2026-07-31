// ══════════════════════════════════════════════════════════════════
//  VISA BYPASS — Content Script (Isolated World)
// ══════════════════════════════════════════════════════════════════
//  Bridges inject.js (main world) ↔ background.js (service worker)
//
//  Flow (no overlay dialog — fully automatic):
//  1. inject.js detects CF 403 → posts VISA_CF_BLOCK to window
//  2. content.js receives it → sends VISA_OPEN_CF_TAB to background
//  3. background opens a new tab with the blocked API URL
//  4. User solves captcha in that tab, closes it
//  5. background sends VISA_CF_TAB_CLOSED or VISA_CF_SOLVED
//  6. content.js posts VISA_CONTINUE_REQUEST → inject.js retries
// ══════════════════════════════════════════════════════════════════

// ── Inject main-world script ──────────────────────────────────────
const script = document.createElement('script');
script.src = chrome.runtime.getURL('inject.js');
script.onload = () => script.remove();
(document.head || document.documentElement).appendChild(script);

// ── State ─────────────────────────────────────────────────────────
let isEnabled = true;
let isSolving = false;
let blockedQueue = [];
let keepAliveEnabled = true;
let keepAliveTimer = null;

// Load persisted state
chrome.storage.local
  .get(['enabled', 'keepAlive'])
  .then((result) => {
    if (result.enabled === false) isEnabled = false;
    if (result.keepAlive === false) keepAliveEnabled = false;
    startKeepAlive();
  })
  .catch(() => startKeepAlive());

// ── Keep-Alive (prevents auto-logout) ─────────────────────────────
//  The portal logs users out after ~40 min of inactivity.  We send
//  a lightweight same-origin request every 5 minutes to refresh the
//  server-side session.  If the response is a redirect to a login
//  page (or the URL itself changes to one), we alert the user.

const KEEP_ALIVE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const LOGIN_URL_PATTERNS = [
  /(^|\/)(login|signin|logon)(\/|$|\?)/i,
  /session[-_]?expired/i,
];

function looksLikeLoginUrl(url) {
  return LOGIN_URL_PATTERNS.some((re) => re.test(url || ''));
}

let urlWatchTimer = null;

function startKeepAlive() {
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
  if (urlWatchTimer) {
    clearInterval(urlWatchTimer);
    urlWatchTimer = null;
  }
  if (!keepAliveEnabled) return;
  keepAliveTimer = setInterval(sendKeepAlive, KEEP_ALIVE_INTERVAL_MS);
  urlWatchTimer = setInterval(checkForLogoutNavigation, 2000);
}

async function sendKeepAlive() {
  if (!keepAliveEnabled) return;
  if (looksLikeLoginUrl(window.location.href)) return; // already logged out

  try {
    // Derive from the user's actual subdomain so the session cookie
    // (often domain-scoped) is always sent.
    const keepAliveUrl = new URL('/en-US/', window.location.origin).href;
    const resp = await fetch(keepAliveUrl, {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
      redirect: 'follow',
    });

    // If the portal redirected us to a login page, the session died
    if (resp.redirected && looksLikeLoginUrl(resp.url)) {
      reportLogout();
      return;
    }
    // 401 on the main page almost certainly means logged out.
    // 403 counts ONLY if it's NOT a Cloudflare challenge (which we
    // already handle via the PSE blocker flow).
    if (resp.status === 401) {
      reportLogout();
      return;
    }
    if (
      resp.status === 403 &&
      resp.headers.get('cf-mitigated') !== 'challenge'
    ) {
      reportLogout();
    }
  } catch (_) {
    // Network error — ignore, session state unknown
  }
}

let logoutReportedAt = 0;
function reportLogout() {
  const now = Date.now();
  if (now - logoutReportedAt < 60 * 1000) return; // throttle to 1/min
  logoutReportedAt = now;
  chrome.runtime.sendMessage({ type: 'VISA_LOGOUT_DETECTED' }).catch(() => {});
}

// ── Logout detection via URL changes (SPA navigation) ─────────────
//  The portal is an SPA — watch history for navigations to login.
let lastHref = window.location.href;
function checkForLogoutNavigation() {
  if (!keepAliveEnabled) return;
  const href = window.location.href;
  if (href !== lastHref) {
    lastHref = href;
    if (looksLikeLoginUrl(href)) reportLogout();
  }
}

// ── Queue Processing ──────────────────────────────────────────────

function processQueue() {
  if (blockedQueue.length === 0) return;

  chrome.runtime.sendMessage({
    type: 'VISA_OPEN_CF_TAB',
    blockedUrl: blockedQueue.shift(),
  });

  isSolving = true;

  // Safety timeout: auto-reset after 10 minutes
  setTimeout(() => {
    if (isSolving) {
      isSolving = false;
      blockedQueue = [];
    }
  }, 10 * 60 * 1000);
}

function onSolveComplete() {
  isSolving = false;

  // Clear the queue — all waiting fetches/XHRs in inject.js will
  // retry with the fresh cf_clearance via VISA_CONTINUE_REQUEST.
  // If any retry still gets 403, it posts a new VISA_CF_BLOCK which
  // will trigger a new solve naturally (self-healing).
  blockedQueue = [];

  // Broadcast continue to ALL waiting fetches/XHRs in inject.js
  window.postMessage({ type: 'VISA_CONTINUE_REQUEST' }, '*');
}

function onLicenseFailed() {
  isSolving = false;
  blockedQueue = [];

  // Broadcast abort to ALL waiting fetches/XHRs in inject.js
  // They will return the original 403 response (no retry).
  window.postMessage({ type: 'VISA_LICENSE_FAILED' }, '*');
}

// ── Communication ─────────────────────────────────────────────────

// Listen for CF block notifications from injected main-world script
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (!event.data || event.data.type !== 'VISA_CF_BLOCK') return;
  if (!isEnabled) return;

  const blockedUrl = event.data.url || 'https://www.usvisascheduling.com/en-US/';

  if (isSolving) {
    // Already solving one — queue this for later
    if (!blockedQueue.includes(blockedUrl)) {
      blockedQueue.push(blockedUrl);
    }
    return;
  }

  // Start a new solve
  blockedQueue.push(blockedUrl);
  processQueue();
});

// Listen for messages from background service worker
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'VISA_CF_SOLVED' || message.type === 'VISA_CF_TAB_CLOSED') {
    onSolveComplete();
  }

  if (message.type === 'VISA_LICENSE_FAILED') {
    onLicenseFailed();
  }

  if (message.type === 'VISA_CF_SOLVE_ERROR') {
    // Couldn't open tab — reset and clear queue
    isSolving = false;
    blockedQueue = [];
  }

  if (message.type === 'VISA_STATUS_CHANGE') {
    isEnabled = message.enabled;
  }

  if (message.type === 'VISA_KEEP_ALIVE_CHANGE') {
    keepAliveEnabled = message.enabled;
    startKeepAlive();
  }
});
