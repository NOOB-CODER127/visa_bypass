// ══════════════════════════════════════════════════════════════════
//  VISA BYPASS — Admin Authentication Helper
// ══════════════════════════════════════════════════════════════════
//
//  Validates the X-Admin-Password header against ADMIN_PASSWORD env var.
//  Returns null on success, or an error object on failure.
// ══════════════════════════════════════════════════════════════════

function requireAdmin(req) {
  const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
  const password = req.headers['x-admin-password'];

  if (!password || password !== adminPassword) {
    return { error: 'Unauthorized — invalid admin password' };
  }
  return null; // authorized
}

module.exports = { requireAdmin };
