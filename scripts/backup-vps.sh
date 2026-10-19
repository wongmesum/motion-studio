#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/var/www/app.bangalimin.com}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/motion-studio}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
BACKUP_SKIP_REDIS="${BACKUP_SKIP_REDIS:-0}"
COMPOSE_COMMAND="${COMPOSE_COMMAND:-docker compose}"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ARCHIVE_NAME="motion-studio-${TIMESTAMP}.tar.gz"
ARCHIVE_PATH="${BACKUP_DIR}/${ARCHIVE_NAME}"
TEMP_ARCHIVE_PATH="${ARCHIVE_PATH}.partial"
TEMP_DIR=""

fail() {
  printf 'Backup gagal: %s\n' "$1" >&2
  exit 1
}

cleanup() {
  rm -f "$TEMP_ARCHIVE_PATH"
  if [[ -n "$TEMP_DIR" ]]; then
    rm -rf "$TEMP_DIR"
  fi
}
trap cleanup EXIT

[[ -d "$APP_DIR" ]] || fail "direktori aplikasi tidak ditemukan: ${APP_DIR}"
[[ -d "$APP_DIR/vps-server/data" ]] || fail "data aplikasi tidak ditemukan"
[[ -d "$APP_DIR/output" ]] || fail "direktori output tidak ditemukan"
[[ "$RETENTION_DAYS" =~ ^[1-9][0-9]*$ ]] || fail "RETENTION_DAYS harus bilangan bulat positif"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
TEMP_DIR="$(mktemp -d "${BACKUP_DIR}/.motion-studio-backup.XXXXXX")"

archive_sources=(-C "$APP_DIR" vps-server/data output)

if [[ "$BACKUP_SKIP_REDIS" != "1" ]]; then
  # Check the binary the configured compose command actually invokes, so an operator
  # override is validated against what will really run.
  compose_bin="${COMPOSE_COMMAND%% *}"
  command -v "$compose_bin" >/dev/null 2>&1 || fail "Docker tidak ditemukan untuk backup Redis"

  # Stop Redis outright instead of pausing it. `CLIENT PAUSE` expires on its own clock, so
  # a snapshot slower than that window would silently run against a volume accepting
  # writes. A stopped container cannot accept a write at all, which makes the copy
  # consistent no matter how long it takes. Redis availability is restored before the
  # archive is written, so the write-blocking window is bounded by the copy itself.
  redis_stopped=0
  restart_redis() {
    if [[ "$redis_stopped" != "1" ]]; then
      return 0
    fi
    if (
      cd "$APP_DIR"
      $COMPOSE_COMMAND up -d --wait redis >/dev/null
    ); then
      redis_stopped=0
      return 0
    fi
    printf 'Backup gagal: Redis tidak dapat dijalankan kembali\n' >&2
    # Keep the flag set: a later attempt must still try to bring Redis back.
    return 1
  }
  cleanup_with_restart() {
    local status=$?
    local restart_status=0
    restart_redis || restart_status=1
    cleanup
    # Redis left down must never look like a successful run.
    if [[ "$status" -eq 0 && "$restart_status" -ne 0 ]]; then
      exit 1
    fi
    exit "$status"
  }
  trap cleanup_with_restart EXIT

  # Arm cleanup before stopping. A signal after Compose stops the container but before
  # the next shell statement must still restart Redis. Starting an already-running
  # service is safe if the stop itself fails.
  redis_stopped=1
  (
    cd "$APP_DIR"
    $COMPOSE_COMMAND stop redis >/dev/null
  ) || fail "gagal menghentikan Redis untuk snapshot"
  (
    cd "$APP_DIR"
    $COMPOSE_COMMAND run --rm --no-deps -T redis tar -C /data -czf - . \
      >"$TEMP_DIR/redis-data.tar.gz"
  ) || fail "snapshot Redis gagal"
  restart_redis || fail "Redis tidak dapat dijalankan kembali setelah snapshot"

  archive_sources+=(-C "$TEMP_DIR" redis-data.tar.gz)
fi

tar -czf "$TEMP_ARCHIVE_PATH" "${archive_sources[@]}" || fail "pembuatan arsip gagal"
tar -tzf "$TEMP_ARCHIVE_PATH" >/dev/null || fail "verifikasi struktur arsip gagal"
chmod 600 "$TEMP_ARCHIVE_PATH"
mv "$TEMP_ARCHIVE_PATH" "$ARCHIVE_PATH"
(
  cd "$BACKUP_DIR"
  sha256sum "$ARCHIVE_NAME" >"${ARCHIVE_NAME}.sha256"
  chmod 600 "${ARCHIVE_NAME}.sha256"
)

# Match only names this script can generate. A broad prefix glob could delete an
# operator's manually named archive that happens to start with "motion-studio-".
find "$BACKUP_DIR" -maxdepth 1 -regextype posix-extended -type f \
  -regex '.*/motion-studio-[0-9]{8}T[0-9]{6}Z\.tar\.gz(\.sha256)?' \
  -mtime "+${RETENTION_DAYS}" -delete

printf 'Backup selesai: %s\n' "$ARCHIVE_PATH"
