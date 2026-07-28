// ══════════════════════════════════════════════════════════════════
//  VISA BYPASS — Popup Script
// ══════════════════════════════════════════════════════════════════

const toggle = document.getElementById('toggle');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const licenseBadge = document.getElementById('licenseBadge');

// License UI
const licenseNotActive = document.getElementById('licenseNotActive');
const licenseActive = document.getElementById('licenseActive');
const licenseKeyInput = document.getElementById('licenseKeyInput');
const activateBtn = document.getElementById('activateBtn');
const deactivateBtn = document.getElementById('deactivateBtn');
const licenseStatus = document.getElementById('licenseStatus');
const licenseInfo = document.getElementById('licenseInfo');

let isLicensed = false;

// ── Load state from background (server-verified) ─────────────────

async function loadState() {
  // Ask background for server-verified status
  chrome.runtime.sendMessage({ type: 'VISA_GET_STATUS' });
}

// Listen for the status response
chrome.runtime.onMessage.addListener(function statusListener(message) {
  if (message.type === 'VISA_STATUS') {
    const enabled = message.enabled;
    toggle.checked = enabled;
    updateToggleUI(enabled, message.licensed);

    if (message.licensed) {
      isLicensed = true;
      showLicensed(message.licenseInfo);
    } else {
      isLicensed = false;
      showUnlicensed();
    }
  }
});

// Trigger initial load
loadState().catch((err) => console.error('Visa Bypass: Error loading state', err));

// ── Toggle handler ────────────────────────────────────────────────

toggle.addEventListener('change', () => {
  const enabled = toggle.checked;
  chrome.runtime.sendMessage({ type: 'VISA_TOGGLE', enabled });
  updateToggleUI(enabled);
});

function updateToggleUI(enabled, licensed) {
  if (enabled && licensed) {
    statusDot.className = 'status-dot active';
    statusText.textContent = 'Active — blocking PSE0501';
  } else if (enabled && !licensed) {
    statusDot.className = 'status-dot inactive';
    statusText.textContent = 'Activate license to enable';
  } else {
    statusDot.className = 'status-dot inactive';
    statusText.textContent = 'Disabled — pass through all errors';
  }
}

// ── License Activation ────────────────────────────────────────────

activateBtn.addEventListener('click', () => {
  const key = licenseKeyInput.value.trim();
  if (!key) {
    showLicenseError('Enter a license key');
    return;
  }

  setLicenseLoading(true);
  chrome.runtime.sendMessage({ type: 'VISA_ACTIVATE_LICENSE', licenseKey: key });
});

deactivateBtn.addEventListener('click', async () => {
  await chrome.storage.local.remove('license');
  isLicensed = false;
  showUnlicensed();
  updateToggleUI(toggle.checked);
  licenseBadge.textContent = 'Unlicensed';

  // Notify tabs
  chrome.tabs.query({ url: '*://*.usvisascheduling.com/*' }).then((tabs) => {
    tabs.forEach((tab) => {
      chrome.tabs.sendMessage(tab.id, { type: 'VISA_LICENSE_CHANGE', licensed: false }).catch(() => {});
    });
  });
});

// ── Listen for license verification result ────────────────────────

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'VISA_LICENSE_STATUS') {
    setLicenseLoading(false);

    if (message.valid) {
      isLicensed = true;
      showLicensed({
        expiresAt: message.expiresAt,
        key: licenseKeyInput.value.trim().toUpperCase(),
      });
      updateToggleUI(toggle.checked);
      licenseBadge.textContent = 'Licensed ✓';
    } else {
      showLicenseError(message.error || 'Activation failed');
    }
  }


});

// ── UI Helpers ────────────────────────────────────────────────────

function showLicensed(license) {
  licenseNotActive.style.display = 'none';
  licenseActive.style.display = 'block';

  const expires = license.expiresAt
    ? new Date(license.expiresAt).toLocaleDateString()
    : 'Never';
  licenseInfo.innerHTML = `
    <span>✓ Activated</span>
    <span style="color:#888;font-size:11px;margin-left:4px;">Expires: ${expires}</span>
  `;

  licenseBadge.textContent = 'Licensed ✓';
  licenseBadge.style.background = '#e8f5e9';
  licenseBadge.style.color = '#2e7d32';
}

function showUnlicensed() {
  licenseNotActive.style.display = 'block';
  licenseActive.style.display = 'none';
  licenseKeyInput.value = '';
  licenseStatus.textContent = '';
  licenseStatus.className = 'license-status';
  licenseBadge.textContent = 'Unlicensed';
  licenseBadge.style.background = '#fff3e0';
  licenseBadge.style.color = '#e65100';
}

function showLicenseError(msg) {
  licenseStatus.textContent = '✗ ' + msg;
  licenseStatus.className = 'license-status invalid';
}

function setLicenseLoading(loading) {
  activateBtn.disabled = loading;
  activateBtn.textContent = loading ? 'Verifying...' : 'Activate';
  if (loading) {
    licenseStatus.innerHTML = '<span class="spinner"></span> Verifying license...';
    licenseStatus.className = 'license-status';
  }
}

// ── Auto-uppercase license key input ──────────────────────────────
licenseKeyInput.addEventListener('input', () => {
  licenseKeyInput.value = licenseKeyInput.value.toUpperCase();
});
