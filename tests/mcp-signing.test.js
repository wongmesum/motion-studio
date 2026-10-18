import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.VPS_TOKEN = 'mcp-vps-token-secure-value';
const { buildHeaders } = await import('../mcp-server/tools/vps-render.js');

test('MCP signs request whenever HMAC_SECRET exists', () => {
  const payload = { html: '<html></html>', fps: 60 };
  process.env.HMAC_SECRET = 'mcp-hmac-secret-secure-value';
  process.env.REQUIRE_HMAC_SIGNATURE = 'false';

  const headers = buildHeaders(payload);
  const expected = crypto
    .createHmac('sha256', process.env.HMAC_SECRET)
    .update(JSON.stringify(payload))
    .digest('hex');
  assert.equal(headers['X-Signature'], expected);
  assert.equal(headers['X-Token'], process.env.VPS_TOKEN);
});

test('MCP fails closed when HMAC is required without secret', () => {
  delete process.env.HMAC_SECRET;
  process.env.REQUIRE_HMAC_SIGNATURE = 'true';
  assert.throws(
    () => buildHeaders({ html: '<html></html>' }),
    /HMAC_SECRET is not configured/
  );
});
