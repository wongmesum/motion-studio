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

fail() {
  printf 'Restore gagal: %s\n' "$1" >&2
  exit 1
}

cleanup() {
  if [[ "$REDIS_STOPPED" == "1" && "$REDIS_SAFE_TO_START" == "1" ]]; then
    (
      cd "$APP_DIR"
      $COMPOSE_COMMAND up -d redis >/dev/null
    ) || printf 'Restore gagal: Redis tidak dapat dijalankan kembali\n' >&2
  fi
  if [[ -n "$TEMP_DIR" ]]; then
    rm -rf "$TEMP_DIR"
  fi
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
  command -v docker >/dev/null 2>&1 || fail "Docker tidak ditemukan untuk restore Redis"

  # Prove the snapshot is a readable tarball before touching live Redis. Deleting the
  # live volume first would turn a corrupt snapshot into total data loss, so Redis is
  # stopped only once there is something valid to put back.
  tar -tzf "$RESTORE_TARGET_DIR/redis-data.tar.gz" >/dev/null || fail "snapshot Redis rusak"

  (
    cd "$APP_DIR"
    $COMPOSE_COMMAND stop redis
  ) || fail "gagal menghentikan Redis"
  REDIS_STOPPED=1
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
    (
      cd "$APP_DIR"
      $COMPOSE_COMMAND run --rm --no-deps -T redis sh -c 'rm -rf /data/* && tar -C /data -xzf -' \
        <"$TEMP_DIR/redis-live-rollback.tar.gz"
    ) || {
      # Starting Redis here would serve a half-extracted dataset, so the trap must not.
      REDIS_SAFE_TO_START=0
      fail "restore dan rollback Redis gagal; Redis tetap dihentikan untuk melindungi data"
    }
    fail "restore Redis gagal; data lama sudah dipulihkan"
  fi
fi

printf 'Restore terverifikasi: %s\n' "$RESTORE_TARGET_DIR"
