// ══════════════════════════════════════════════════════════════════
//  VISA BYPASS — GET /api/admin/stats
//  Vercel serverless function
// ══════════════════════════════════════════════════════════════════

const { getStats } = require('../../lib/db');
const { requireAdmin } = require('../../lib/auth');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Password');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const authError = requireAdmin(req);
  if (authError) return res.status(401).json(authError);

  try {
    const stats = await getStats();
    res.json(stats);
  } catch (err) {
    console.error('admin stats error:', err);
    res.status(500).json({ error: 'Failed to load stats' });
  }
};
