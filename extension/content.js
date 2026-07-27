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
let isLicensed = false;
let pendingSolve = false;

// Load persisted state
Promise.all([
  chrome.storage.local.get(['enabled']),
  chrome.storage.local.get(['license']),
]).then(([enabledResult, licenseResult]) => {
  if (enabledResult.enabled === false) isEnabled = false;
  if (licenseResult.license && licenseResult.license.verified) isLicensed = true;
});

// ── Communication ─────────────────────────────────────────────────

// Listen for CF block notifications from injected main-world script
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (!event.data || event.data.type !== 'VISA_CF_BLOCK') return;
  if (!isEnabled || !isLicensed) return;
  if (pendingSolve) return; // Already handling one

  pendingSolve = true;
  const blockedUrl = event.data.url || 'https://www.usvisascheduling.com/en-US/';

  // Safety timeout: auto-reset after 3 minutes so extension can't get stuck
  setTimeout(() => { pendingSolve = false; }, 3 * 60 * 1000);

  // Tell background to open CF solve tab to the blocked URL
  chrome.runtime.sendMessage({
    type: 'VISA_OPEN_CF_TAB',
    blockedUrl: blockedUrl,
  });
});

// Listen for messages from background service worker
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'VISA_CF_SOLVED') {
    // Cookie was detected — auto-retry
    pendingSolve = false;
    window.postMessage({ type: 'VISA_CONTINUE_REQUEST' }, '*');
  }

  if (message.type === 'VISA_CF_TAB_CLOSED') {
    // User closed the solve tab — retry automatically
    pendingSolve = false;
    window.postMessage({ type: 'VISA_CONTINUE_REQUEST' }, '*');
  }

  if (message.type === 'VISA_CF_SOLVE_ERROR') {
    // Couldn't open tab — reset so next block attempt works
    pendingSolve = false;
  }

  if (message.type === 'VISA_STATUS_CHANGE') {
    isEnabled = message.enabled;
  }

  if (message.type === 'VISA_LICENSE_CHANGE') {
    isLicensed = message.licensed;
  }
});
