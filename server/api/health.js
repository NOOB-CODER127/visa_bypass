// ══════════════════════════════════════════════════════════════════
//  VISA BYPASS — GET /health
//  Vercel serverless function
// ══════════════════════════════════════════════════════════════════

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'Visa Bypass License Server',
  });
};
