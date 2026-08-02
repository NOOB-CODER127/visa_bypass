// ══════════════════════════════════════════════════════════════════
//  VISA BYPASS — Popup Script
// ══════════════════════════════════════════════════════════════════

const toggle = document.getElementById('toggle');
const keepAliveToggle = document.getElementById('keepAliveToggle');
const relayToggle = document.getElementById('relayToggle');
const relayNote = document.getElementById('relayNote');
const vpnToggle = document.getElementById('vpnToggle');
const vpnNote = document.getElementById('vpnNote');
const vpnConfig = document.getElementById('vpnConfig');
const vpnHost = document.getElementById('vpnHost');
const vpnPort = document.getElementById('vpnPort');
const vpnSaveBtn = document.getElementById('vpnSaveBtn');
const vpnRotateBtn = document.getElementById('vpnRotateBtn');
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
    keepAliveToggle.checked = message.keepAlive !== false;
    relayToggle.checked = message.relay === true;
    updateRelayUI(message.relay === true, message.licensed);
    vpnToggle.checked = message.vpn === true;
    if (message.vpnHost) vpnHost.value = message.vpnHost;
    if (message.vpnPort) vpnPort.value = message.vpnPort;
    updateVpnUI(message.vpn === true);
    updateToggleUI(enabled);

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

// ── Keep-alive toggle ────────────────────────────────────────────

keepAliveToggle.addEventListener('change', () => {
  const enabled = keepAliveToggle.checked;
  chrome.runtime.sendMessage({ type: 'VISA_KEEP_ALIVE_TOGGLE', enabled });
});

// ── Proxy relay toggle ───────────────────────────────────────────

relayToggle.addEventListener('change', () => {
  const enabled = relayToggle.checked;
  chrome.runtime.sendMessage({ type: 'VISA_RELAY_TOGGLE', enabled });
  updateRelayUI(enabled, isLicensed);
});

function updateRelayUI(enabled, licensed) {
  if (enabled && vpnToggle.checked) {
    relayNote.textContent =
      '⚠ Superseded by IP Rotation (Software VPN) — turn this relay OFF.';
    relayNote.style.color = '#b45309';
  } else if (enabled && !licensed) {
    relayNote.textContent =
      '⚠ License required — activate a license to use the rotating IP relay.';
    relayNote.style.color = '#b45309';
  } else if (enabled) {
    relayNote.textContent =
      'Active — calendar requests exit via rotating residential IPs.';
    relayNote.style.color = '#16a34a';
  } else {
    relayNote.textContent =
      'Routes calendar requests via rotating residential IPs to avoid rate limits. Requires an active license.';
    relayNote.style.color = '#888';
  }
}

// ── Software VPN (browser proxy) toggle ──────────────────────────

vpnToggle.addEventListener('change', () => {
  const enabled = vpnToggle.checked;
  chrome.runtime.sendMessage({ type: 'VISA_VPN_TOGGLE', enabled }, (resp) => {
    if (resp && resp.ok) {
      updateVpnUI(enabled);
    } else {
      // Roll back on failure
      vpnToggle.checked = !enabled;
      updateVpnUI(!enabled);
      vpnNote.textContent = '⚠ Could not enable proxy. Check host/port.';
      vpnNote.style.color = '#b45309';
    }
  });
});

vpnSaveBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage(
    {
      type: 'VISA_VPN_SAVE',
      host: vpnHost.value.trim(),
      port: vpnPort.value.trim(),
    },
    (resp) => {
      if (resp && resp.ok) {
        vpnNote.textContent = '✓ Proxy settings saved.';
        vpnNote.style.color = '#16a34a';
        setTimeout(() => updateVpnUI(vpnToggle.checked), 1500);
      } else {
        vpnNote.textContent =
          '⚠ ' + ((resp && resp.error) || 'Could not save settings.');
        vpnNote.style.color = '#b45309';
      }
    }
  );
});

vpnRotateBtn.addEventListener('click', () => {
  vpnRotateBtn.disabled = true;
  vpnRotateBtn.textContent = '↻ Rotating IP...';
  chrome.runtime.sendMessage({ type: 'VISA_CHANGE_IP' });
  setTimeout(() => {
    vpnRotateBtn.disabled = false;
    vpnRotateBtn.textContent = '🔄 Change IP (reloads visa tabs)';
    vpnNote.textContent = '✓ Rotated — visa tabs reloaded on a fresh IP.';
    vpnNote.style.color = '#16a34a';
  }, 2500);
});

function updateVpnUI(enabled) {
  vpnConfig.style.display = enabled ? 'block' : 'none';
  if (enabled) {
    vpnNote.textContent =
      'Active — visa traffic exits via rotating residential IPs. Enter proxy credentials when Chrome asks (once).';
    vpnNote.style.color = '#16a34a';
  } else {
    vpnNote.textContent =
      'Routes your real browser through the residential proxy — a software VPN. No more manual VPN toggling.';
    vpnNote.style.color = '#888';
  }
}

function updateToggleUI(enabled) {
  // Interception no longer requires a license — status reflects the
  // toggle only. License info is display-only (badge below).
  if (enabled) {
    statusDot.className = 'status-dot active';
    statusText.textContent = 'Active — blocking PSE0501';
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

deactivateBtn.addEventListener('click', () => {
  // Delegate to background — clears both in-memory cache and storage
  chrome.runtime.sendMessage({ type: 'VISA_DEACTIVATE_LICENSE' });
  isLicensed = false;
  showUnlicensed();
  updateToggleUI(toggle.checked);
  licenseBadge.textContent = 'Unlicensed';
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
      updateRelayUI(relayToggle.checked, true);
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
