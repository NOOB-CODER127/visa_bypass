// ══════════════════════════════════════════════════════════════════
//  VISA BYPASS — POST /api/admin/generate
//  Vercel serverless function
// ══════════════════════════════════════════════════════════════════
//
//  Admin HTML sends POST to /api/admin/generate (separate from
//  the /api/admin/licenses list endpoint).
//

const { generateLicenses } = require('../../lib/db');
const { requireAdmin } = require('../../lib/auth');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Password');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const authError = requireAdmin(req);
  if (authError) return res.status(401).json(authError);

  try {
    const { count = 1, daysValid = 365, features = ['basic'], maxDevices = 3 } = req.body || {};

    if (count < 1 || count > 100) {
      return res.status(400).json({ error: 'Count must be between 1 and 100' });
    }

    const safeDays = Math.max(1, Math.min(3650, Number(daysValid) || 365));
    const safeDevices = Math.max(1, Math.min(50, Number(maxDevices) || 3));

    const result = await generateLicenses({
      count: Math.min(100, Math.max(1, Number(count) || 1)),
      daysValid: safeDays,
      features,
      maxDevices: safeDevices,
    });

    return res.json(result);
  } catch (err) {
    console.error('admin generate error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};
