// ══════════════════════════════════════════════════════════════════
//  VISA BYPASS — License Server
// ══════════════════════════════════════════════════════════════════
//
//  Deploy:     https://render.com  (set PORT, ADMIN_PASSWORD env vars)
//  Domain:     suwate26.com
//  Admin UI:   https://suwate26.com/admin
//
//  Public API:
//    POST /api/verify-license    — Verify a license key
//
//  Admin API (requires X-Admin-Password header):
//    GET    /api/admin/licenses  — List all licenses
//    GET    /api/admin/stats     — License stats
//    POST   /api/admin/generate  — Generate new license(s)
//    DELETE /api/admin/licenses/:key — Delete a license
//    PUT    /api/admin/licenses/:key — Update a license (extend expiry)
// ══════════════════════════════════════════════════════════════════

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();

// Trust Render's proxy so req.ip and X-Forwarded-Proto work correctly
app.set('trust proxy', 1);

app.use(express.json());
app.use(cors());

const LICENSE_DATA_DIR = process.env.LICENSE_DATA_DIR || __dirname;
const LICENSES_FILE = path.join(LICENSE_DATA_DIR, 'licenses.json');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

// ── Load / Save licenses ──────────────────────────────────────────

function loadLicenses() {
  try {
    const raw = fs.readFileSync(LICENSES_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function saveLicenses(licenses) {
  fs.writeFileSync(LICENSES_FILE, JSON.stringify(licenses, null, 2));
}

// ── Health check (Render uses this to verify the service is alive) ─
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/', (req, res) => {
  res.json({
    service: 'Visa Bypass License Server',
    domain: 'suwate26.com',
    docs: '/health',
    admin: '/admin',
  });
});

// ── Auth middleware for admin endpoints ───────────────────────────

function requireAdmin(req, res, next) {
  const password = req.headers['x-admin-password'];
  if (!password || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized — invalid admin password' });
  }
  next();
}

// ── Generate a license key ────────────────────────────────────────

function generateKey() {
  const segments = [];
  for (let i = 0; i < 3; i++) {
    segments.push(crypto.randomBytes(3).toString('hex').toUpperCase());
  }
  return `VISA-${segments.join('-')}`;
}

// ══════════════════════════════════════════════════════════════════
//  PUBLIC API
// ══════════════════════════════════════════════════════════════════

// ── POST /api/verify-license ──────────────────────────────────────

app.post('/api/verify-license', (req, res) => {
  const { licenseKey } = req.body;

  if (!licenseKey || typeof licenseKey !== 'string') {
    return res.status(400).json({ valid: false, error: 'License key is required' });
  }

  const key = licenseKey.trim().toUpperCase();
  const licenses = loadLicenses();
  const license = licenses[key];

  if (!license) {
    return res.json({ valid: false, error: 'Invalid license key' });
  }

  if (license.expiresAt && new Date(license.expiresAt) < new Date()) {
    return res.json({ valid: false, error: 'License has expired' });
  }

  if (license.revoked) {
    return res.json({ valid: false, error: 'License has been revoked' });
  }

  if (license.maxDevices && license.devices && license.devices.length >= license.maxDevices) {
    return res.json({ valid: false, error: 'Maximum devices activated' });
  }

  res.json({
    valid: true,
    expiresAt: license.expiresAt,
    features: license.features || ['basic'],
  });
});

// ══════════════════════════════════════════════════════════════════
//  ADMIN API
// ══════════════════════════════════════════════════════════════════

// ── GET /api/admin/stats ──────────────────────────────────────────

app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const licenses = loadLicenses();
  const list = Object.entries(licenses);
  const total = list.length;
  const active = list.filter(
    ([, l]) => !l.revoked && (!l.expiresAt || new Date(l.expiresAt) > new Date())
  ).length;
  const expired = list.filter(
    ([, l]) => !l.revoked && l.expiresAt && new Date(l.expiresAt) <= new Date()
  ).length;
  const revoked = list.filter(([, l]) => l.revoked).length;
  res.json({ total, active, expired, revoked });
});

// ── GET /api/admin/licenses ────────────────────────────────────────

app.get('/api/admin/licenses', requireAdmin, (req, res) => {
  const licenses = loadLicenses();
  const now = new Date();
  const summary = {};
  for (const [key, data] of Object.entries(licenses)) {
    summary[key] = {
      created: data.created,
      expiresAt: data.expiresAt,
      features: data.features || ['basic'],
      maxDevices: data.maxDevices || 3,
      deviceCount: (data.devices || []).length,
      revoked: !!data.revoked,
      status: data.revoked
        ? 'revoked'
        : data.expiresAt && new Date(data.expiresAt) <= now
          ? 'expired'
          : 'active',
    };
  }
  res.json(summary);
});

// ── POST /api/admin/generate ──────────────────────────────────────

app.post('/api/admin/generate', requireAdmin, (req, res) => {
  const { count = 1, daysValid = 365, features = ['basic'], maxDevices = 3 } = req.body;

  if (count < 1 || count > 100) {
    return res.status(400).json({ error: 'Count must be between 1 and 100' });
  }

  const licenses = loadLicenses();
  const now = new Date();
  const generated = [];

  for (let i = 0; i < count; i++) {
    const key = generateKey();
    const expiresAt = new Date(now);
    expiresAt.setDate(expiresAt.getDate() + daysValid);

    licenses[key] = {
      created: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      features: features,
      maxDevices: maxDevices,
      devices: [],
      revoked: false,
    };

    generated.push(key);
  }

  saveLicenses(licenses);

  res.json({
    generated: generated.length,
    keys: generated,
    expiresAt: new Date(now.getTime() + daysValid * 86400000).toISOString(),
  });
});

// ── DELETE /api/admin/licenses/:key ────────────────────────────────

app.delete('/api/admin/licenses/:key', requireAdmin, (req, res) => {
  const key = req.params.key.toUpperCase();
  const licenses = loadLicenses();

  if (!licenses[key]) {
    return res.status(404).json({ error: 'License key not found' });
  }

  delete licenses[key];
  saveLicenses(licenses);

  res.json({ deleted: true, key });
});

// ── PUT /api/admin/licenses/:key (revoke or update) ───────────────

app.put('/api/admin/licenses/:key', requireAdmin, (req, res) => {
  const key = req.params.key.toUpperCase();
  const licenses = loadLicenses();

  if (!licenses[key]) {
    return res.status(404).json({ error: 'License key not found' });
  }

  const license = licenses[key];

  // Revoke
  if (req.body.revoked === true) {
    license.revoked = true;
    license.revokedAt = new Date().toISOString();
  }

  // Un-revoke
  if (req.body.revoked === false) {
    license.revoked = false;
    delete license.revokedAt;
  }

  // Extend expiry
  if (req.body.extendDays) {
    const currentExpiry = license.expiresAt ? new Date(license.expiresAt) : new Date();
    currentExpiry.setDate(currentExpiry.getDate() + req.body.extendDays);
    license.expiresAt = currentExpiry.toISOString();
  }

  // Update features
  if (req.body.features) {
    license.features = req.body.features;
  }

  // Update max devices
  if (req.body.maxDevices !== undefined) {
    license.maxDevices = req.body.maxDevices;
  }

  saveLicenses(licenses);

  res.json({
    updated: true,
    key,
    expiresAt: license.expiresAt,
    features: license.features,
    revoked: !!license.revoked,
    maxDevices: license.maxDevices,
  });
});

// ══════════════════════════════════════════════════════════════════
//  ADMIN UI
// ══════════════════════════════════════════════════════════════════

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ══════════════════════════════════════════════════════════════════
//  START SERVER
// ══════════════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║     VISA BYPASS — License Server                   ║');
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log(`║  Domain:    suwate26.com                             ║`);
  console.log(`║  Admin UI:  ${baseUrl}/admin                          ║`);
  console.log(`║  API:       ${baseUrl}/api/verify-license              ║`);
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`  ⚠  Set ADMIN_PASSWORD env var in production!`);
  console.log(`  ⚠  Licenses are stored in server/licenses.json`);
  console.log(`     → Attach a Render Disk at /data for persistence`);
});
