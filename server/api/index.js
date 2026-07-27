// ══════════════════════════════════════════════════════════════════
//  VISA BYPASS — GET /
//  Vercel serverless function
// ══════════════════════════════════════════════════════════════════

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  const baseUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : 'http://localhost:3000';

  res.json({
    service: 'Visa Bypass License Server',
    domain: process.env.VERCEL_URL || 'suwate26.com',
    docs: '/health',
    admin: '/admin',
    verify: '/api/verify-license',
  });
};
