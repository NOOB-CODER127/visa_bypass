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

// Load persisted state
chrome.storage.local.get(['enabled']).then((result) => {
  if (result.enabled === false) isEnabled = false;
});

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
});
