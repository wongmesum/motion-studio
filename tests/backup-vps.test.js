import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'backup-vps.sh');

function readText(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

// The script needs a POSIX shell and tar. Both ship with Git Bash on Windows, but
// skip rather than fail when the host genuinely cannot run it.
const shellProbe = spawnSync('bash', ['-c', 'command -v tar && command -v sha256sum'], {
  encoding: 'utf8',
});
const canRun = shellProbe.status === 0;

function makeWorkspace() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-backup-'));
  fs.mkdirSync(path.join(base, 'app', 'vps-server', 'data'), { recursive: true });
  fs.mkdirSync(path.join(base, 'app', 'output'), { recursive: true });
  fs.mkdirSync(path.join(base, 'app', 'cache'), { recursive: true });
  fs.mkdirSync(path.join(base, 'app', 'frames'), { recursive: true });
  fs.mkdirSync(path.join(base, 'backups'), { recursive: true });
  fs.writeFileSync(path.join(base, 'app', 'vps-server', 'data', 'admin-store.json'), '{"users":[]}');
  fs.writeFileSync(path.join(base, 'app', 'vps-server', 'data', 'generated-secrets.json'), '{}');
  fs.writeFileSync(path.join(base, 'app', 'output', 'job-1.mp4'), 'video-bytes');
  fs.writeFileSync(path.join(base, 'app', 'cache', 'job-1.json'), '{"cached":true}');
  fs.writeFileSync(path.join(base, 'app', 'frames', 'frame-0001.png'), 'frame-bytes');
  return base;
}

function toShellPath(filePath) {
  if (process.platform !== 'win32') return filePath;
  const converted = spawnSync('cygpath', ['-u', filePath], { encoding: 'utf8' });
  assert.equal(converted.status, 0, converted.stderr);
  return converted.stdout.trim();
}

// Git Bash ships the tools the script relies on, but the Node process inherits the
// Windows PATH, where the native bsdtar rejects `C:\...` as a remote host.
function runShell(command, cwd) {
  const shellCommand = cwd ? `cd '${toShellPath(cwd)}' && ${command}` : command;
  return spawnSync('bash', ['-c', shellCommand], { encoding: 'utf8' });
}

function runBackup(base, extraEnv = {}) {
  return spawnSync('bash', ['scripts/backup-vps.sh'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      APP_DIR: toShellPath(path.join(base, 'app')),
      BACKUP_DIR: toShellPath(path.join(base, 'backups')),
      // Redis lives in a Docker volume on the VPS; the workspace has no Docker daemon.
      BACKUP_SKIP_REDIS: '1',
      ...extraEnv,
    },
  });
}

function listBackups(base) {
  return fs.readdirSync(path.join(base, 'backups')).sort();
}

test('a backup run writes a verifiable archive of the persisted state', { skip: !canRun }, () => {
  const base = makeWorkspace();
  const result = runBackup(base);
  assert.equal(result.status, 0, `backup script failed:\n${result.stdout}\n${result.stderr}`);

  const archives = listBackups(base).filter((name) => name.endsWith('.tar.gz'));
  assert.equal(archives.length, 1, 'exactly one archive per run');

  const checksums = listBackups(base).filter((name) => name.endsWith('.sha256'));
  assert.deepEqual(
    checksums,
    [`${archives[0]}.sha256`],
    'each archive needs a sidecar checksum so a corrupt backup is detectable'
  );

  const verify = runShell(`sha256sum -c '${archives[0]}.sha256'`, path.join(base, 'backups'));
  assert.equal(verify.status, 0, `checksum verification failed:\n${verify.stdout}${verify.stderr}`);

  const listing = runShell(`tar -tzf '${toShellPath(path.join(base, 'backups', archives[0]))}'`);
  assert.equal(listing.status, 0, listing.stderr);
  assert.match(listing.stdout, /vps-server\/data\/admin-store\.json/);
  assert.match(listing.stdout, /output\/job-1\.mp4/);
});

test('a backup excludes regenerable render scratch state', { skip: !canRun }, () => {
  const base = makeWorkspace();
  assert.equal(runBackup(base).status, 0);

  const archive = listBackups(base).find((name) => name.endsWith('.tar.gz'));
  const listing = runShell(`tar -tzf '${toShellPath(path.join(base, 'backups', archive))}'`);

  // Frames are per-job scratch and the cache is content-addressable, so both are
  // rebuilt on demand. Copying them would inflate every backup for no recovery value.
  assert.doesNotMatch(listing.stdout, /frames\//);
  assert.doesNotMatch(listing.stdout, /cache\//);
});

test('a backup prunes archives past the retention window only', { skip: !canRun }, () => {
  const base = makeWorkspace();
  const backupsDir = path.join(base, 'backups');
  const stale = path.join(backupsDir, 'motion-studio-20200101T000000Z.tar.gz');
  fs.writeFileSync(stale, 'old-archive');
  fs.writeFileSync(`${stale}.sha256`, 'deadbeef  motion-studio-20200101T000000Z.tar.gz');
  fs.writeFileSync(path.join(backupsDir, 'unrelated-notes.txt'), 'keep me');

  // Backdate well past the retention window without relying on relative offsets.
  const backdated = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
  const stamp = backdated.toISOString().replace(/[-:T]/g, '').slice(0, 12) + '.00';
  runShell(`touch -t ${stamp} '${toShellPath(stale)}' '${toShellPath(stale)}.sha256'`);

  const result = runBackup(base, { RETENTION_DAYS: '14' });
  assert.equal(result.status, 0, result.stderr);

  const remaining = listBackups(base);
  assert.ok(!remaining.includes('motion-studio-20200101T000000Z.tar.gz'), 'stale archive must be pruned');
  assert.ok(
    !remaining.includes('motion-studio-20200101T000000Z.tar.gz.sha256'),
    'stale checksum must be pruned with its archive'
  );
  assert.ok(remaining.includes('unrelated-notes.txt'), 'retention must not touch files it does not own');
  assert.ok(remaining.some((name) => name.endsWith('.tar.gz') && !name.startsWith('motion-studio-2020')));
});

test('a backup refuses to run when the application directory is absent', { skip: !canRun }, () => {
  const base = makeWorkspace();
  const missing = path.join(base, 'not-the-app');
  const result = runBackup(base, { APP_DIR: missing });

  assert.notEqual(result.status, 0, 'a silent success on a missing directory would hide a broken cron job');
  assert.equal(listBackups(base).length, 0, 'no archive should be produced for a missing source');
});

function runRestore(base, extraEnv = {}) {
  return spawnSync('bash', ['scripts/restore-vps.sh'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      RESTORE_TARGET_DIR: toShellPath(path.join(base, 'restored')),
      ...extraEnv,
    },
  });
}

test('a restore rejects an archive whose sidecar names nothing verifiable', { skip: !canRun }, () => {
  const base = makeWorkspace();
  assert.equal(runBackup(base).status, 0);
  const name = listBackups(base).find((n) => n.endsWith('.tar.gz'));
  const archivePath = path.join(base, 'backups', name);
  fs.writeFileSync(path.join(base, 'backups', `${name}.sha256`), '\n');

  const result = runRestore(base, { RESTORE_ARCHIVE: toShellPath(archivePath) });
  assert.notEqual(result.status, 0, 'an empty sidecar must not be treated as a valid match');
});

test('a restored archive reproduces the persisted state byte for byte', { skip: !canRun }, () => {
  const base = makeWorkspace();
  assert.equal(runBackup(base).status, 0);
  const archive = toShellPath(path.join(base, 'backups', listBackups(base).find((n) => n.endsWith('.tar.gz'))));

  const result = runRestore(base, { RESTORE_ARCHIVE: archive });
  assert.equal(result.status, 0, `restore failed:\n${result.stdout}\n${result.stderr}`);

  const restored = path.join(base, 'restored');
  assert.equal(fs.readFileSync(path.join(restored, 'vps-server', 'data', 'admin-store.json'), 'utf8'), '{"users":[]}');
  assert.equal(fs.readFileSync(path.join(restored, 'output', 'job-1.mp4'), 'utf8'), 'video-bytes');
  // The workspace runs with BACKUP_SKIP_REDIS=1, so no Redis snapshot is expected here.
  assert.ok(!fs.existsSync(path.join(restored, 'redis-data.tar.gz')));
});

test('a restore refuses an archive whose checksum does not match', { skip: !canRun }, () => {
  const base = makeWorkspace();
  assert.equal(runBackup(base).status, 0);
  const name = listBackups(base).find((n) => n.endsWith('.tar.gz'));
  const archivePath = path.join(base, 'backups', name);

  // Corrupt the payload while leaving the recorded digest untouched: this is exactly
  // what a truncated upload or a bad disk looks like, and restoring it silently would
  // overwrite good state with garbage.
  const bytes = fs.readFileSync(archivePath);
  bytes[Math.floor(bytes.length / 2)] ^= 0xff;
  fs.writeFileSync(archivePath, bytes);

  const result = runRestore(base, { RESTORE_ARCHIVE: toShellPath(archivePath) });
  assert.notEqual(result.status, 0, 'a checksum mismatch must abort the restore');
  assert.ok(!fs.existsSync(path.join(base, 'restored')), 'nothing may be written when verification fails');
});

test('a restore refuses to overwrite an existing directory', { skip: !canRun }, () => {
  const base = makeWorkspace();
  assert.equal(runBackup(base).status, 0);
  const archive = toShellPath(path.join(base, 'backups', listBackups(base).find((n) => n.endsWith('.tar.gz'))));

  const target = path.join(base, 'restored');
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'keep.txt'), 'do not clobber');

  const result = runRestore(base, { RESTORE_ARCHIVE: archive });
  assert.notEqual(result.status, 0, 'restoring over live state needs an explicit opt-in');
  assert.ok(fs.existsSync(path.join(target, 'keep.txt')), 'the existing directory must be left untouched');
});

test('the scheduled backup unit runs the verified script on a recurring timer', () => {
  const service = readText('deploy/systemd/motion-studio-backup.service');
  const timer = readText('deploy/systemd/motion-studio-backup.timer');

  assert.match(service, /ExecStart=\/usr\/local\/sbin\/motion-studio-backup/);
  // The unit runs unattended as root, so a failed run must be visible rather than silent.
  assert.match(service, /Type=oneshot/);
  assert.match(timer, /OnCalendar=daily/);
  assert.match(timer, /Persistent=true/, 'a missed run after downtime must still execute');
  assert.match(timer, /WantedBy=timers\.target/);
});

test('retention only removes archives this script generated', { skip: !canRun }, () => {
  const base = makeWorkspace();
  const backupsDir = path.join(base, 'backups');

  // Hand-kept files that merely share the prefix must survive: the operator named them,
  // and deleting them would destroy something the script never created.
  for (const name of [
    'motion-studio-manual-copy.tar.gz',
    'motion-studio-20200101.tar.gz',
    'motion-studio-notes.tar.gz.sha256',
  ]) {
    fs.writeFileSync(path.join(backupsDir, name), 'operator-owned');
  }
  const stamp = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000)
    .toISOString()
    .replace(/[-:T]/g, '')
    .slice(0, 12) + '.00';
  runShell(
    `touch -t ${stamp} '${toShellPath(backupsDir)}'/motion-studio-manual-copy.tar.gz ` +
      `'${toShellPath(backupsDir)}'/motion-studio-20200101.tar.gz ` +
      `'${toShellPath(backupsDir)}'/motion-studio-notes.tar.gz.sha256`
  );

  assert.equal(runBackup(base, { RETENTION_DAYS: '14' }).status, 0);

  const remaining = listBackups(base);
  assert.ok(remaining.includes('motion-studio-manual-copy.tar.gz'), 'non-generated name must survive');
  assert.ok(remaining.includes('motion-studio-20200101.tar.gz'), 'name without a timestamp must survive');
  assert.ok(remaining.includes('motion-studio-notes.tar.gz.sha256'), 'checksum without an archive must survive');
});

test('a restore rejects a checksum that names a different archive', { skip: !canRun }, () => {
  const base = makeWorkspace();
  assert.equal(runBackup(base).status, 0);
  const name = listBackups(base).find((n) => n.endsWith('.tar.gz'));
  const archivePath = path.join(base, 'backups', name);

  // Corrupt the archive, then point its sidecar at a different intact file. Verifying
  // "whatever the sidecar names" would report success while the real archive is bad.
  const bytes = fs.readFileSync(archivePath);
  bytes[Math.floor(bytes.length / 2)] ^= 0xff;
  fs.writeFileSync(archivePath, bytes);
  fs.writeFileSync(path.join(base, 'backups', 'decoy.tar.gz'), 'intact-decoy');
  const decoyDigest = runShell(
    `sha256sum decoy.tar.gz`,
    path.join(base, 'backups')
  ).stdout.split(/\s+/)[0];
  fs.writeFileSync(path.join(base, 'backups', `${name}.sha256`), `${decoyDigest}  decoy.tar.gz\n`);

  const result = runRestore(base, { RESTORE_ARCHIVE: toShellPath(archivePath) });
  assert.notEqual(result.status, 0, 'a sidecar naming another file must not verify the archive');
});

test('a Redis backup stops writes until its volume snapshot finishes', { skip: !canRun }, () => {
  const base = makeWorkspace();
  const stubLog = path.join(base, 'compose-calls.log');
  const stub = path.join(base, 'compose-stub.sh');
  fs.writeFileSync(
    stub,
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$STUB_LOG"
if [[ "$*" == *"tar -C /data -czf - ."* ]]; then
  tar -czf - -C "$STUB_REDIS_DATA" .
fi
exit 0
`
  );
  fs.chmodSync(stub, 0o755);
  const redisData = path.join(base, 'redis-data');
  fs.mkdirSync(redisData);
  fs.writeFileSync(path.join(redisData, 'dump.rdb'), 'redis-bytes');

  const result = runBackup(base, {
    BACKUP_SKIP_REDIS: '0',
    COMPOSE_COMMAND: toShellPath(stub),
    STUB_LOG: toShellPath(stubLog),
    STUB_REDIS_DATA: toShellPath(redisData),
  });
  assert.equal(result.status, 0, result.stderr);

  const calls = fs.readFileSync(stubLog, 'utf8').trim().split(/\r?\n/);
  const stopIndex = calls.findIndex((call) => call.includes('stop redis'));
  const archiveIndex = calls.findIndex((call) => call.includes('tar -C /data -czf - .'));
  const restartIndex = calls.findIndex((call) => call.includes('up -d --wait redis'));
  assert.ok(stopIndex >= 0 && stopIndex < archiveIndex, 'Redis must stop before reading its volume');
  assert.ok(restartIndex > archiveIndex, 'Redis must restart only after the volume snapshot finishes');
  assert.ok(!calls.some((call) => call.includes('CLIENT PAUSE')), 'snapshot must not depend on expiring pauses');
});

test('a Redis backup fails when Redis cannot restart healthy', { skip: !canRun }, () => {
  const base = makeWorkspace();
  const stub = path.join(base, 'compose-stub.sh');
  fs.writeFileSync(
    stub,
    `#!/usr/bin/env bash
if [[ "$*" == *"up -d --wait redis"* ]]; then
  exit 1
fi
if [[ "$*" == *"tar -C /data -czf - ."* ]]; then
  tar -czf - -C "$STUB_REDIS_DATA" .
fi
exit 0
`
  );
  fs.chmodSync(stub, 0o755);
  const redisData = path.join(base, 'redis-data');
  fs.mkdirSync(redisData);
  fs.writeFileSync(path.join(redisData, 'dump.rdb'), 'redis-bytes');

  const result = runBackup(base, {
    BACKUP_SKIP_REDIS: '0',
    COMPOSE_COMMAND: toShellPath(stub),
    STUB_REDIS_DATA: toShellPath(redisData),
  });

  assert.notEqual(result.status, 0, 'backup must fail when Redis does not become healthy');
  assert.match(result.stderr, /Redis tidak dapat dijalankan kembali/);
});

test('a restore arms Redis restart before issuing stop', { skip: !canRun }, () => {
  const script = readText('scripts/restore-vps.sh');
  const stopFunction = script.slice(
    script.indexOf('stop_redis() {'),
    script.indexOf('restore_redis_rollback() {')
  );
  const armed = stopFunction.indexOf('REDIS_STOPPED=1');
  const stopped = stopFunction.indexOf('$COMPOSE_COMMAND stop redis');

  assert.ok(armed >= 0, 'restore must track that Redis may be stopped');
  assert.ok(stopped > armed, 'restart cleanup must be armed before Compose can stop Redis');
  // The rollback path stops Redis too, so arming inside the helper covers every caller.
  assert.match(script, /stop_redis \|\| fail "gagal menghentikan Redis"/);
});

test('a restore returns failure when Redis cannot restart', { skip: !canRun }, () => {
  const script = readText('scripts/restore-vps.sh');
  assert.match(
    script,
    /restart_redis[\s\S]*return 1[\s\S]*RESTORE_STATUS=1/,
    'restart failure must affect the process exit code instead of only logging'
  );
});

test('a restore that cannot restart Redis exits nonzero even after a good restore', { skip: !canRun }, () => {
  const base = makeWorkspace();
  const appDir = path.join(base, 'app');

  // A valid inner Redis snapshot, so the restore itself succeeds and only the final
  // restart fails. That is the case a trap can silently swallow.
  const redisPayload = path.join(base, 'redis-payload');
  fs.mkdirSync(redisPayload);
  fs.writeFileSync(path.join(redisPayload, 'dump.rdb'), 'redis-bytes');
  const inner = runShell(
    `tar -czf '${toShellPath(path.join(base, 'redis-data.tar.gz'))}' -C '${toShellPath(redisPayload)}' .`
  );
  assert.equal(inner.status, 0, inner.stderr);

  const fixtureArchive = toShellPath(
    path.join(base, 'backups', 'motion-studio-20200101T000000Z.tar.gz')
  );
  const fixture = runShell(
    `tar -czf '${fixtureArchive}' ` +
      `-C '${toShellPath(appDir)}' vps-server/data output ` +
      `-C '${toShellPath(base)}' redis-data.tar.gz`
  );
  assert.equal(fixture.status, 0, fixture.stderr);
  runShell(
    `cd '${toShellPath(path.join(base, 'backups'))}' && sha256sum motion-studio-20200101T000000Z.tar.gz > motion-studio-20200101T000000Z.tar.gz.sha256`
  );

  const stubLog = path.join(base, 'compose-calls.log');
  const stub = path.join(base, 'compose-stub.sh');
  fs.writeFileSync(
    stub,
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$STUB_LOG"
if [[ "$*" == *"up -d --wait redis"* ]]; then
  exit 1
fi
if [[ "$*" == *"tar -C /data -czf - ."* ]]; then
  tar -czf - -C "$STUB_REDIS_DATA" .
fi
exit 0
`
  );
  fs.chmodSync(stub, 0o755);

  const result = runRestore(base, {
    RESTORE_ARCHIVE: toShellPath(path.join(base, 'backups', 'motion-studio-20200101T000000Z.tar.gz')),
    RESTORE_REDIS: '1',
    APP_DIR: toShellPath(appDir),
    COMPOSE_COMMAND: toShellPath(stub),
    STUB_LOG: toShellPath(stubLog),
    STUB_REDIS_DATA: toShellPath(redisPayload),
  });

  assert.notEqual(
    result.status,
    0,
    `a restart failure must not be reported as a successful restore\n${result.stdout}\n${result.stderr}`
  );
  assert.ok(fs.existsSync(stubLog), `compose stub should have run\n${result.stdout}\n${result.stderr}`);
  const calls = fs.readFileSync(stubLog, 'utf8');
  assert.match(calls, /up -d --wait redis/, 'the trap must attempt to bring Redis back up');
  assert.match(calls, /Restore|up -d --wait redis/, 'restart must be attempted before exiting');
  assert.match(result.stderr, /Redis tidak dapat dijalankan kembali/);
});

// Builds an archive whose inner Redis snapshot is a valid tarball, so extraction succeeds
// and only the health check can fail. Returns the archive path.
function makeHealthyExtractFixture(base, appDir) {
  const redisPayload = path.join(base, 'redis-payload');
  fs.mkdirSync(redisPayload);
  fs.writeFileSync(path.join(redisPayload, 'dump.rdb'), 'redis-bytes');
  const inner = runShell(
    `tar -czf '${toShellPath(path.join(base, 'redis-data.tar.gz'))}' -C '${toShellPath(redisPayload)}' .`
  );
  assert.equal(inner.status, 0, inner.stderr);

  const archivePath = path.join(base, 'backups', 'motion-studio-20200101T000000Z.tar.gz');
  const fixture = runShell(
    `tar -czf '${toShellPath(archivePath)}' ` +
      `-C '${toShellPath(appDir)}' vps-server/data output ` +
      `-C '${toShellPath(base)}' redis-data.tar.gz`
  );
  assert.equal(fixture.status, 0, fixture.stderr);
  runShell(
    `cd '${toShellPath(path.join(base, 'backups'))}' && sha256sum motion-studio-20200101T000000Z.tar.gz > motion-studio-20200101T000000Z.tar.gz.sha256`
  );
  return archivePath;
}

test('a restore rolls back when the restored dataset cannot become healthy', { skip: !canRun }, () => {
  const base = makeWorkspace();
  const appDir = path.join(base, 'app');
  const archivePath = makeHealthyExtractFixture(base, appDir);

  const stubLog = path.join(base, 'compose-calls.log');
  const attemptFile = path.join(base, 'health-attempts');
  const stub = path.join(base, 'compose-stub.sh');
  // The restored dataset starts unhealthy; the rollback dataset starts clean. A valid
  // tarball can still hold an RDB that Redis refuses to load.
  fs.writeFileSync(
    stub,
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$STUB_LOG"
if [[ "$*" == *"up -d --wait redis"* ]]; then
  attempt=$(( $(cat "$ATTEMPT_FILE" 2>/dev/null || echo 0) + 1 ))
  printf '%s' "$attempt" > "$ATTEMPT_FILE"
  [[ "$attempt" -gt 1 ]] || exit 1
fi
if [[ "$*" == *"tar -C /data -czf - ."* ]]; then
  tar -czf - -C "$STUB_REDIS_DATA" .
fi
exit 0
`
  );
  fs.chmodSync(stub, 0o755);

  const result = runRestore(base, {
    RESTORE_ARCHIVE: toShellPath(archivePath),
    RESTORE_REDIS: '1',
    APP_DIR: toShellPath(appDir),
    COMPOSE_COMMAND: toShellPath(stub),
    STUB_LOG: toShellPath(stubLog),
    STUB_REDIS_DATA: toShellPath(path.join(base, 'redis-payload')),
    ATTEMPT_FILE: toShellPath(attemptFile),
  });

  assert.notEqual(result.status, 0, 'an unhealthy restored dataset must fail the restore');
  assert.match(result.stderr, /data lama sudah dipulihkan/, 'the previous dataset must be put back');

  const calls = fs.readFileSync(stubLog, 'utf8');
  const rollbacks = calls.split(/\r?\n/).filter((call) => call.includes('rm -rf /data/*')).length;
  assert.ok(rollbacks >= 2, 'rollback must re-extract the pre-restore snapshot');
  assert.match(calls, /up -d --wait redis/, 'Redis must be restarted after rollback');
});

test('a restore keeps the rollback snapshot when recovery itself fails', { skip: !canRun }, () => {
  const base = makeWorkspace();
  const appDir = path.join(base, 'app');
  const archivePath = makeHealthyExtractFixture(base, appDir);

  const stub = path.join(base, 'compose-stub.sh');
  // Redis never becomes healthy again, so recovery is impossible and the snapshot must
  // survive for an operator instead of being deleted by cleanup.
  fs.writeFileSync(
    stub,
    `#!/usr/bin/env bash
if [[ "$*" == *"up -d --wait redis"* ]]; then
  exit 1
fi
if [[ "$*" == *"tar -C /data -czf - ."* ]]; then
  tar -czf - -C "$STUB_REDIS_DATA" .
fi
exit 0
`
  );
  fs.chmodSync(stub, 0o755);

  const result = runRestore(base, {
    RESTORE_ARCHIVE: toShellPath(archivePath),
    RESTORE_REDIS: '1',
    APP_DIR: toShellPath(appDir),
    COMPOSE_COMMAND: toShellPath(stub),
    STUB_REDIS_DATA: toShellPath(path.join(base, 'redis-payload')),
  });

  assert.notEqual(result.status, 0, 'unrecoverable Redis must fail the restore');
  const match = result.stderr.match(/snapshot rollback dipertahankan di (\S+)/);
  assert.ok(match, `a failed recovery must point at the kept snapshot\n${result.stderr}`);
  const rollbackSnapshot = `${match[1]}/redis-live-rollback.tar.gz`;
  const snapshotCheck = runShell(`test -f '${rollbackSnapshot}'`);
  assert.equal(
    snapshotCheck.status,
    0,
    'the pre-restore snapshot must not be deleted when rollback fails'
  );
});

test('a restore never stops Redis when the Redis snapshot is unusable', { skip: !canRun }, () => {
  const base = makeWorkspace();
  const appDir = path.join(base, 'app');

  // Hand-build an archive whose inner Redis payload is not a tarball at all.
  fs.writeFileSync(path.join(base, 'redis-data.tar.gz'), 'this is not a gzip stream');
  const fixtureArchive = toShellPath(
    path.join(base, 'backups', 'motion-studio-20200101T000000Z.tar.gz')
  );
  const fixture = runShell(
    `tar -czf '${fixtureArchive}' ` +
      `-C '${toShellPath(appDir)}' vps-server/data output ` +
      `-C '${toShellPath(base)}' redis-data.tar.gz`
  );
  assert.equal(fixture.status, 0, fixture.stderr);
  runShell(`cd '${toShellPath(path.join(base, 'backups'))}' && sha256sum motion-studio-20200101T000000Z.tar.gz > motion-studio-20200101T000000Z.tar.gz.sha256`);

  const stubLog = path.join(base, 'compose-calls.log');
  const stub = path.join(base, 'compose-stub.sh');
  fs.writeFileSync(stub, '#!/usr/bin/env bash\nprintf \'%s\\n\' "$*" >> "$STUB_LOG"\nexit 0\n');
  fs.chmodSync(stub, 0o755);

  const result = runRestore(base, {
    RESTORE_ARCHIVE: toShellPath(path.join(base, 'backups', 'motion-studio-20200101T000000Z.tar.gz')),
    RESTORE_REDIS: '1',
    APP_DIR: toShellPath(appDir),
    COMPOSE_COMMAND: toShellPath(stub),
    STUB_LOG: toShellPath(stubLog),
  });

  assert.notEqual(result.status, 0, 'an unusable Redis snapshot must abort the restore');
  const calls = fs.existsSync(stubLog) ? fs.readFileSync(stubLog, 'utf8') : '';
  assert.doesNotMatch(calls, /stop/, 'Redis must not be stopped before its replacement is proven usable');
});
