#!/usr/bin/env node
// Reads the admin password from stdin so it never reaches argv, shell history, or
// process listings. Prints only the scrypt hash for .env.
import { hashAdminPassword } from '../security/admin-session.js';

const MAX_PASSWORD_BYTES = 4096;

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
      if (Buffer.byteLength(data, 'utf8') > MAX_PASSWORD_BYTES) {
        reject(new Error('Password input exceeded the maximum accepted size'));
        process.stdin.destroy();
      }
    });
    process.stdin.on('end', () => resolve(data.replace(/\r?\n$/, '')));
    process.stdin.on('error', reject);
  });
}

try {
  const password = await readStdin();
  process.stdout.write(`${await hashAdminPassword(password)}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
