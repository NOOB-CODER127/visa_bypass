// ══════════════════════════════════════════════════════════════════
//  VISA BYPASS — GET /api/admin/licenses  |  POST /api/admin/generate
//  Vercel serverless function
// ══════════════════════════════════════════════════════════════════

const { getAllLicenses, generateLicenses } = require('../../lib/db');
const { requireAdmin } = require('../../lib/auth');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Password');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const authError = requireAdmin(req);
  if (authError) return res.status(401).json(authError);

  try {
    if (req.method === 'GET') {
      const licenses = await getAllLicenses();
      return res.json(licenses);
    }

    if (req.method === 'POST') {
      const { count = 1, daysValid = 365, features = ['basic'], maxDevices = 3 } = req.body || {};

      if (count < 1 || count > 100) {
        return res.status(400).json({ error: 'Count must be between 1 and 100' });
      }

      // Sanitize inputs
      const safeDays = Math.max(1, Math.min(3650, Number(daysValid) || 365));
      const safeDevices = Math.max(1, Math.min(50, Number(maxDevices) || 3));

      const result = await generateLicenses({
        count: Math.min(100, Math.max(1, Number(count) || 1)),
        daysValid: safeDays,
        features,
        maxDevices: safeDevices,
      });

      return res.json(result);
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('admin licenses error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};
