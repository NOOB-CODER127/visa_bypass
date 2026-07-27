// ══════════════════════════════════════════════════════════════════
//  VISA BYPASS — Database Module (Vercel Postgres)
// ══════════════════════════════════════════════════════════════════
//
//  Uses @vercel/postgres — env vars auto-injected by Vercel when
//  a Postgres database is linked to the project.
//
//  Env vars (set automatically by Vercel on linked DB):
//    POSTGRES_URL, POSTGRES_USER, POSTGRES_HOST, POSTGRES_PASSWORD
//    POSTGRES_DATABASE, POSTGRES_URL_NON_POOLING
// ══════════════════════════════════════════════════════════════════

const { sql } = require('@vercel/postgres');
const crypto = require('crypto');

let initialized = false;

// ── Schema Init ───────────────────────────────────────────────────

async function initDb() {
  if (initialized) return;
  await sql`
    CREATE TABLE IF NOT EXISTS licenses (
      key           TEXT PRIMARY KEY,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      expires_at    TIMESTAMPTZ NOT NULL,
      revoked       BOOLEAN DEFAULT FALSE,
      features      TEXT[] DEFAULT ARRAY['basic'],
      max_devices   INTEGER DEFAULT 3,
      last_verified TIMESTAMPTZ
    );
  `;
  initialized = true;
}

// ── Key Generator ─────────────────────────────────────────────────

function generateKey() {
  const segments = [];
  for (let i = 0; i < 3; i++) {
    segments.push(crypto.randomBytes(3).toString('hex').toUpperCase());
  }
  return `VISA-${segments.join('-')}`;
}

// ── Verify License (public API) ───────────────────────────────────

async function verifyLicense(key) {
  await initDb();

  const { rows } = await sql`SELECT * FROM licenses WHERE key = ${key};`;
  if (rows.length === 0) return { valid: false, error: 'Invalid license key' };

  const l = rows[0];

  if (new Date(l.expires_at) < new Date()) {
    return { valid: false, error: 'License has expired' };
  }
  if (l.revoked) {
    return { valid: false, error: 'License has been revoked' };
  }

  await sql`UPDATE licenses SET last_verified = NOW() WHERE key = ${key};`;

  return {
    valid: true,
    expiresAt: l.expires_at.toISOString(),
    features: l.features || ['basic'],
  };
}

// ── Stats (admin) ─────────────────────────────────────────────────

async function getStats() {
  await initDb();

  const { rows } = await sql`
    SELECT
      COUNT(*)::int                                          AS total,
      COUNT(*) FILTER (WHERE NOT revoked AND expires_at > NOW())::int AS active,
      COUNT(*) FILTER (WHERE NOT revoked AND expires_at <= NOW())::int AS expired,
      COUNT(*) FILTER (WHERE revoked)::int                   AS revoked
    FROM licenses;
  `;
  return rows[0];
}

// ── List All Licenses (admin) ────────────────────────────────────

async function getAllLicenses() {
  await initDb();

  const { rows } = await sql`
    SELECT key, created_at, expires_at, revoked, features, max_devices
    FROM licenses
    ORDER BY created_at DESC;
  `;

  const now = new Date();
  const summary = {};
  for (const row of rows) {
    summary[row.key] = {
      created: row.created_at ? row.created_at.toISOString() : null,
      expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
      features: row.features || ['basic'],
      maxDevices: row.max_devices || 3,
      deviceCount: 0,
      revoked: !!row.revoked,
      status: row.revoked
        ? 'revoked'
        : row.expires_at && new Date(row.expires_at) <= now
          ? 'expired'
          : 'active',
    };
  }
  return summary;
}

// ── Generate License Keys (admin) ────────────────────────────────

async function generateLicenses({ count = 1, daysValid = 365, features = ['basic'], maxDevices = 3 }) {
  await initDb();

  const now = new Date();
  const generated = [];

  for (let i = 0; i < count; i++) {
    const key = generateKey();
    const expiresAt = new Date(now.getTime() + daysValid * 86400000);

    await sql`
      INSERT INTO licenses (key, expires_at, features, max_devices)
      VALUES (${key}, ${expiresAt.toISOString()}, ${features}, ${maxDevices});
    `;
    generated.push(key);
  }

  return {
    generated: generated.length,
    keys: generated,
    expiresAt: new Date(now.getTime() + daysValid * 86400000).toISOString(),
  };
}

// ── Update License (admin) ───────────────────────────────────────

async function updateLicense(key, updates) {
  await initDb();

  const { rows } = await sql`SELECT * FROM licenses WHERE key = ${key};`;
  if (rows.length === 0) return null;

  if (updates.revoked === true) {
    await sql`UPDATE licenses SET revoked = TRUE WHERE key = ${key};`;
  } else if (updates.revoked === false) {
    await sql`UPDATE licenses SET revoked = FALSE WHERE key = ${key};`;
  }

  if (updates.extendDays) {
    const currentExpiry = new Date(rows[0].expires_at);
    currentExpiry.setDate(currentExpiry.getDate() + updates.extendDays);
    await sql`UPDATE licenses SET expires_at = ${currentExpiry.toISOString()}::timestamptz WHERE key = ${key};`;
  }

  if (updates.features) {
    await sql`UPDATE licenses SET features = ${updates.features} WHERE key = ${key};`;
  }

  if (updates.maxDevices !== undefined) {
    await sql`UPDATE licenses SET max_devices = ${updates.maxDevices} WHERE key = ${key};`;
  }

  const { rows: updated } = await sql`SELECT * FROM licenses WHERE key = ${key};`;
  if (updated.length === 0) return null;

  return {
    updated: true,
    key,
    expiresAt: updated[0].expires_at.toISOString(),
    features: updated[0].features,
    revoked: !!updated[0].revoked,
    maxDevices: updated[0].max_devices,
  };
}

// ── Delete License (admin) ────────────────────────────────────────

async function deleteLicense(key) {
  await initDb();

  const { rows } = await sql`SELECT key FROM licenses WHERE key = ${key};`;
  if (rows.length === 0) return false;

  await sql`DELETE FROM licenses WHERE key = ${key};`;
  return true;
}

module.exports = {
  verifyLicense,
  getStats,
  getAllLicenses,
  generateLicenses,
  updateLicense,
  deleteLicense,
};
