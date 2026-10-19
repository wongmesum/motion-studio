import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = fs.readFileSync(path.join(ROOT, 'scripts', 'enable-ssh-post-quantum.sh'), 'utf8');

test('the SSH probe daemon cannot inherit a public listener or the production PID file', () => {
  // Copying the production config and appending overrides leaves inherited Port,
  // ListenAddress, and PidFile directives active - a second login endpoint, or a probe
  // that overwrites the production PID file. A minimal config cannot inherit any of them.
  assert.doesNotMatch(
    SCRIPT,
    /sed[^\n]*\/etc\/ssh\/sshd_config/,
    'probe must not be derived from the production config'
  );
  assert.match(SCRIPT, /Include \$\{CANDIDATE\}/);
  assert.match(SCRIPT, /ListenAddress 127\.0\.0\.1/);
  assert.match(SCRIPT, /ListenAddress ::1/);
  assert.match(SCRIPT, /PidFile \$\{PROBE_PIDFILE\}/);
});

test('the candidate config never reaches the live path before it is proven', () => {
  // The live drop-in must be written only after a successful probe negotiation, so the
  // first `install ... "$DROP_IN"` follows the probe result check.
  const negotiation = SCRIPT.indexOf('$NEGOTIATED" ==');
  const install = SCRIPT.indexOf('install -o root -g root -m 600 "$CANDIDATE" "$DROP_IN"');
  assert.ok(negotiation >= 0, 'script must assert the negotiated algorithm');
  assert.ok(install > negotiation, 'live drop-in must be installed after verification');
});

test('every post-install failure restores the previous drop-in', () => {
  const rollbackUses = SCRIPT.match(/rollback_drop_in/g) ?? [];
  // One definition, the EXIT trap, and a call on both the reload and applied-config paths.
  assert.ok(rollbackUses.length >= 4, 'reload and verification failures must both roll back');

  const verifyIndex = SCRIPT.indexOf("sshd -T | grep -q '^kexalgorithms");
  assert.ok(verifyIndex >= 0, 'script must verify the running config actually applies PQ');
  assert.match(
    SCRIPT.slice(verifyIndex),
    /rollback_drop_in/,
    'a config that loads but does not apply PQ must not stay installed'
  );
});

test('the EXIT trap undoes the live drop-in when the script is interrupted', () => {
  // The window between installing the candidate and the explicit checks is small but
  // real; without a trap, a signal there leaves an unverified drop-in live.
  const flagSet = SCRIPT.indexOf('LIVE_INSTALLED=1');
  const install = SCRIPT.indexOf('install -o root -g root -m 600 "$CANDIDATE" "$DROP_IN"');
  assert.ok(flagSet >= 0, 'script must track that the live file was replaced');
  assert.ok(flagSet < install, 'the trap flag must be armed before the live file changes');

  const trapIndex = SCRIPT.indexOf('trap on_exit EXIT');
  assert.ok(trapIndex >= 0, 'script must install an EXIT trap');
  const trapBody = SCRIPT.slice(
    SCRIPT.indexOf('on_exit() {'),
    trapIndex
  );
  assert.match(trapBody, /LIVE_INSTALLED" == "1"/, 'trap must act only when the live file changed');
  assert.match(trapBody, /rollback_drop_in/, 'trap must restore the previous drop-in');
});

test('a successful run keeps the proven candidate installed', () => {
  // The trap must be disarmed after the final check, otherwise exiting normally would
  // roll back the very config the script just proved works.
  const disarmIndex = SCRIPT.indexOf('LIVE_INSTALLED=0', SCRIPT.indexOf('sshd -T | grep -q'));
  const successPrint = SCRIPT.indexOf("SSH post-quantum aktif.");
  assert.ok(disarmIndex >= 0, 'rollback must be disarmed once the candidate is verified');
  assert.ok(disarmIndex < successPrint, 'disarm must happen before the success message');
});

test('a failed rollback is reported and keeps the previous config for recovery', () => {
  const rollback = SCRIPT.slice(
    SCRIPT.indexOf('rollback_drop_in() {'),
    SCRIPT.indexOf('on_exit() {')
  );
  assert.doesNotMatch(
    rollback,
    /\|\| true/,
    'reload failure during rollback must propagate instead of being swallowed'
  );
  assert.match(SCRIPT, /tidak dapat dipulihkan/, 'an unrecovered daemon must be reported');
  assert.match(SCRIPT, /PREVIOUS_KEPT=1/, 'a failed rollback must preserve the old config');
  assert.match(
    SCRIPT,
    /PREVIOUS_KEPT" != "1"[\s\S]*rm -f "\$PREVIOUS"/,
    'cleanup may remove the old config only when recovery did not fail'
  );
});

test('the probe proves its own daemon is alive before trusting negotiation', () => {
  const daemonStart = SCRIPT.indexOf('/usr/sbin/sshd -f "$PROBE_CONFIG"');
  const negotiation = SCRIPT.indexOf('NEGOTIATED="$(ssh');
  const ownershipCheck = SCRIPT.slice(daemonStart, negotiation);

  assert.match(ownershipCheck, /test -s "\$PROBE_PIDFILE"/);
  assert.match(ownershipCheck, /kill -0 "\$\(sudo cat "\$PROBE_PIDFILE"\)"/);
});
