import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

test('password provisioning single-quotes the scrypt hash for Docker Compose', async () => {
  const script = await fs.readFile(path.resolve('scripts/set-admin-password.sh'), 'utf8');

  assert.match(script, /quote = sprintf\("%c", 39\)/);
  assert.match(script, /"ADMIN_PASSWORD_HASH=" quote hash quote/);
  assert.doesNotMatch(script, /print "ADMIN_PASSWORD_HASH=" hash/);
});
