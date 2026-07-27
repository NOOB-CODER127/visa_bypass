// ══════════════════════════════════════════════════════════════════
//  VISA BYPASS — POST /api/verify-license
//  Vercel serverless function
// ══════════════════════════════════════════════════════════════════

const { verifyLicense } = require('../lib/db');

module.exports = async (req, res) => {
  // CORS headers for extension background script
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { licenseKey } = req.body || {};

  if (!licenseKey || typeof licenseKey !== 'string') {
    return res.status(400).json({ valid: false, error: 'License key is required' });
  }

  try {
    const result = await verifyLicense(licenseKey.trim().toUpperCase());
    res.json(result);
  } catch (err) {
    console.error('verify-license error:', err);
    res.status(500).json({ valid: false, error: 'Server error. Please try again.' });
  }
};
