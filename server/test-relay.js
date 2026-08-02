// Temporary test harness for /api/proxy-request
// Run: node server/test-relay.js
process.env.PROXY_HOST = ''; // ensure "proxy not configured" path

// Patch db module BEFORE requiring the endpoint so verifyLicense is stubbed
const db = require('./lib/db');
db.verifyLicense = async (key) => {
  if (key === 'VISA-VALID-123') return { valid: true, expiresAt: '2030-01-01' };
  return { valid: false, error: 'Invalid license key' };
};

const handler = require('./api/proxy-request.js');

function makeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; this.done = true; },
    end() { this.done = true; },
  };
  return res;
}

function call(body) {
  return new Promise((resolve) => {
    const res = makeRes();
    const req = { method: 'POST', body };
    const orig = res.json.bind(res);
    res.json = (b) => { orig(b); resolve({ code: res.statusCode, body: b }); };
    const p = handler(req, res);
    if (p && p.then) p.then(() => resolve({ code: res.statusCode, body: res.body }));
  });
}

(async () => {
  let pass = 0, fail = 0;
  const check = (name, cond) => {
    if (cond) { pass++; console.log('  ✅ ' + name); }
    else { fail++; console.log('  ❌ ' + name); }
  };

  console.log('Test 1: OPTIONS preflight');
  {
    const res = makeRes();
    await handler({ method: 'OPTIONS' }, res);
    check('OPTIONS returns 200', res.statusCode === 200);
  }

  console.log('Test 2: missing license key');
  {
    const r = await call({ url: 'https://www.usvisascheduling.com/en-US/' });
    check('400 + reason license', r.code === 400 && r.body.reason === 'license');
  }

  console.log('Test 3: disallowed target URL (open-proxy guard)');
  {
    const r = await call({ licenseKey: 'VISA-VALID-123', url: 'https://evil.com/steal' });
    check('400 + reason url', r.code === 400 && r.body.reason === 'url');
  }

  console.log('Test 4: invalid license');
  {
    const r = await call({ licenseKey: 'VISA-BAD-KEY', url: 'https://www.usvisascheduling.com/en-US/' });
    check('403 + reason license', r.code === 403 && r.body.reason === 'license');
  }

  console.log('Test 5: valid license but proxy not configured');
  {
    const r = await call({ licenseKey: 'VISA-VALID-123', url: 'https://www.usvisascheduling.com/api/v1/schedule-group/get-family-ofc-schedule-days' });
    check('500 + reason proxy', r.code === 500 && r.body.reason === 'proxy');
  }

  console.log('Test 6: allowlisted host variants');
  {
    const r1 = await call({ licenseKey: 'VISA-VALID-123', url: 'https://www.usvisascheduling.com/x' });
    check('bare host passes allowlist (then hits proxy check)', r1.body.reason === 'proxy');
    const r2 = await call({ licenseKey: 'VISA-VALID-123', url: 'https://sub.usvisascheduling.com.evil.com/x' });
    check('suffix spoof rejected', r2.body.reason === 'url');
    const r3 = await call({ licenseKey: 'VISA-VALID-123', url: 'http://usvisascheduling.com/x' });
    check('plain http rejected', r3.body.reason === 'url');
    const r4 = await call({ licenseKey: 'VISA-VALID-123', url: 'https://usvisascheduling.com:8080/x' });
    check('non-default port rejected', r4.body.reason === 'url');
  }

  console.log('Test 7: isCfChallenge detector');
  {
    const { isCfChallenge } = handler;
    check('429 is challenge', isCfChallenge(429, {}, '') === true);
    check('403 with cf-mitigated', isCfChallenge(403, { 'cf-mitigated': 'challenge' }, '') === true);
    check('403 with server cloudflare', isCfChallenge(403, { server: 'cloudflare' }, '') === true);
    check('403 with html body', isCfChallenge(403, { 'content-type': 'text/html' }, '<html>Just a moment...</html>') === true);
    check('403 bare is treated as challenge', isCfChallenge(403, {}, '') === true);
    check('200 JSON is not challenge', isCfChallenge(200, { 'content-type': 'application/json' }, '{"ok":true}') === false);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
