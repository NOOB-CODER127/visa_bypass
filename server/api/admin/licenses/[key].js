// ══════════════════════════════════════════════════════════════════
//  VISA BYPASS — DELETE | PUT  /api/admin/licenses/:key
//  Vercel serverless function
// ══════════════════════════════════════════════════════════════════

const { updateLicense, deleteLicense } = require('../../../lib/db');
const { requireAdmin } = require('../../../lib/auth');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'DELETE, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Password');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const authError = requireAdmin(req);
  if (authError) return res.status(401).json(authError);

  // Extract key from query param (Vercel file-based routing: [key].js → req.query.key)
  // Fallback: parse from URL path in case of preview environments
  let key = (req.query.key || '').toUpperCase();
  if (!key) {
    const parts = req.url.split('/');
    const lastPart = parts[parts.length - 1];
    if (lastPart && !lastPart.includes('?')) {
      key = lastPart.toUpperCase();
    }
  }
  if (!key) return res.status(400).json({ error: 'License key is required' });

  try {
    if (req.method === 'DELETE') {
      const deleted = await deleteLicense(key);
      if (!deleted) return res.status(404).json({ error: 'License key not found' });
      return res.json({ deleted: true, key });
    }

    if (req.method === 'PUT') {
      const result = await updateLicense(key, req.body || {});
      if (!result) return res.status(404).json({ error: 'License key not found' });
      return res.json(result);
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('admin licenses/[key] error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};
