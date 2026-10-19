#!/usr/bin/env bash
set -Eeuo pipefail

RESTORE_ARCHIVE="${RESTORE_ARCHIVE:-${1:-}}"
RESTORE_TARGET_DIR="${RESTORE_TARGET_DIR:-}"
RESTORE_REDIS="${RESTORE_REDIS:-0}"
APP_DIR="${APP_DIR:-/var/www/app.bangalimin.com}"
COMPOSE_COMMAND="${COMPOSE_COMMAND:-docker compose}"
TEMP_DIR=""
REDIS_STOPPED=0
REDIS_SAFE_TO_START=1
RESTORE_STATUS=0
PRESERVE_TEMP=0

fail() {
  printf 'Restore gagal: %s\n' "$1" >&2
  exit 1
}

restart_redis() {
  if ! (
    cd "$APP_DIR"
    # Compose waits for the image healthcheck (`redis-cli ping`), not merely for the
    # container process to start. A bad restored dataset must fail this restore.
    $COMPOSE_COMMAND up -d --wait redis >/dev/null
  ); then
    printf 'Restore gagal: Redis tidak dapat dijalankan kembali\n' >&2
    return 1
  fi
  REDIS_STOPPED=0
}

stop_redis() {
  REDIS_STOPPED=1
  (
    cd "$APP_DIR"
    $COMPOSE_COMMAND stop redis >/dev/null
  )
}

restore_redis_rollback() {
  [[ -f "$TEMP_DIR/redis-live-rollback.tar.gz" ]] || return 1
  stop_redis || return 1
  (
    cd "$APP_DIR"
    $COMPOSE_COMMAND run --rm --no-deps -T redis sh -c 'rm -rf /data/* && tar -C /data -xzf -' \
      <"$TEMP_DIR/redis-live-rollback.tar.gz"
  ) || return 1
  restart_redis
}

# A restart failure must reach the process exit code. Reporting success while Redis is
# still down would let an automated caller proceed against a stack missing its queue.
cleanup() {
  local status=$?
  if [[ "$REDIS_STOPPED" == "1" && "$REDIS_SAFE_TO_START" == "1" ]]; then
    restart_redis || RESTORE_STATUS=1
  fi
  if [[ -n "$TEMP_DIR" && "$PRESERVE_TEMP" != "1" ]]; then
    rm -rf "$TEMP_DIR"
  fi
  if [[ "$status" -eq 0 && "$RESTORE_STATUS" -ne 0 ]]; then
    exit "$RESTORE_STATUS"
  fi
  exit "$status"
}
trap cleanup EXIT

[[ -n "$RESTORE_ARCHIVE" ]] || fail "RESTORE_ARCHIVE wajib diisi"
[[ -f "$RESTORE_ARCHIVE" ]] || fail "arsip tidak ditemukan: ${RESTORE_ARCHIVE}"
[[ -f "${RESTORE_ARCHIVE}.sha256" ]] || fail "checksum tidak ditemukan"

archive_dir="$(cd "$(dirname "$RESTORE_ARCHIVE")" && pwd)"
archive_name="$(basename "$RESTORE_ARCHIVE")"
checksum_path="${RESTORE_ARCHIVE}.sha256"

# Bind the sidecar to this exact archive. `sha256sum -c` alone trusts the filename
# inside the sidecar, so an attacker or operator mistake could make it verify a decoy.
mapfile -t checksum_lines < <(grep -v '^[[:space:]]*$' "$checksum_path")
[[ ${#checksum_lines[@]} -eq 1 ]] || fail "checksum harus berisi tepat satu entri"
read -r expected_digest expected_name extra <<<"${checksum_lines[0]}"
expected_name="${expected_name#\*}"
[[ "$expected_digest" =~ ^[a-fA-F0-9]{64}$ ]] || fail "format checksum tidak valid"
[[ "$expected_name" == "$archive_name" && -z "${extra:-}" ]] || fail "checksum menunjuk arsip lain"
actual_digest="$(sha256sum "$RESTORE_ARCHIVE" | cut -d ' ' -f 1)"
[[ "${actual_digest,,}" == "${expected_digest,,}" ]] || fail "checksum arsip tidak cocok"
tar -tzf "$RESTORE_ARCHIVE" >/dev/null || fail "struktur arsip rusak"

if [[ -z "$RESTORE_TARGET_DIR" ]]; then
  RESTORE_TARGET_DIR="$(mktemp -d /tmp/motion-studio-restore.XXXXXX)"
else
  [[ ! -e "$RESTORE_TARGET_DIR" ]] || fail "target restore sudah ada: ${RESTORE_TARGET_DIR}"
  mkdir -p "$RESTORE_TARGET_DIR"
fi

tar -xzf "$RESTORE_ARCHIVE" -C "$RESTORE_TARGET_DIR"
[[ -f "$RESTORE_TARGET_DIR/vps-server/data/admin-store.json" ]] || fail "admin-store.json tidak ada dalam arsip"
[[ -f "$RESTORE_TARGET_DIR/vps-server/data/generated-secrets.json" ]] || fail "generated-secrets.json tidak ada dalam arsip"

if [[ "$RESTORE_REDIS" == "1" ]]; then
  [[ -f "$RESTORE_TARGET_DIR/redis-data.tar.gz" ]] || fail "snapshot Redis tidak ada dalam arsip"
  compose_bin="${COMPOSE_COMMAND%% *}"
  command -v "$compose_bin" >/dev/null 2>&1 || fail "Docker tidak ditemukan untuk restore Redis"

  # Prove the snapshot is a readable tarball before touching live Redis. Deleting the
  # live volume first would turn a corrupt snapshot into total data loss, so Redis is
  # stopped only once there is something valid to put back.
  tar -tzf "$RESTORE_TARGET_DIR/redis-data.tar.gz" >/dev/null || fail "snapshot Redis rusak"

  # Arm cleanup before stopping. A signal after Compose stops the container, or a stop
  # that reports failure after the container is already down, must still restart Redis.
  # Starting an already-running service is safe, so this flag errs toward restarting.
  stop_redis || fail "gagal menghentikan Redis"
  TEMP_DIR="$(mktemp -d /tmp/motion-studio-redis-rollback.XXXXXX)"

  # Keep a byte-for-byte rollback snapshot after Redis has stopped writing. If the
  # replacement extraction fails halfway, restore this before starting Redis again.
  (
    cd "$APP_DIR"
    $COMPOSE_COMMAND run --rm --no-deps -T redis tar -C /data -czf - . \
      >"$TEMP_DIR/redis-live-rollback.tar.gz"
  ) || fail "snapshot rollback Redis gagal"
  tar -tzf "$TEMP_DIR/redis-live-rollback.tar.gz" >/dev/null \
    || fail "snapshot rollback Redis rusak"

  if ! (
    cd "$APP_DIR"
    $COMPOSE_COMMAND run --rm --no-deps -T redis sh -c 'rm -rf /data/* && tar -C /data -xzf -' \
      <"$RESTORE_TARGET_DIR/redis-data.tar.gz"
  ); then
    if ! restore_redis_rollback; then
      # Starting Redis here would serve a half-extracted dataset, so the trap must not.
      REDIS_SAFE_TO_START=0
      PRESERVE_TEMP=1
      fail "restore dan rollback Redis gagal; Redis tetap dihentikan dan snapshot rollback dipertahankan di ${TEMP_DIR}"
    fi
    fail "restore Redis gagal; data lama sudah dipulihkan"
  fi

  # A tarball can be structurally readable yet contain an RDB/AOF Redis refuses to load.
  # Verify the restored dataset now, while the rollback snapshot is still available.
  if ! restart_redis; then
    if ! restore_redis_rollback; then
      REDIS_SAFE_TO_START=0
      PRESERVE_TEMP=1
      fail "Redis hasil restore tidak sehat dan rollback gagal; snapshot rollback dipertahankan di ${TEMP_DIR}"
    fi
    fail "Redis hasil restore tidak sehat; data lama sudah dipulihkan"
  fi
fi

printf 'Restore terverifikasi: %s\n' "$RESTORE_TARGET_DIR"
