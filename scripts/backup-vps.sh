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
  command -v docker >/dev/null 2>&1 || fail "Docker tidak ditemukan untuk backup Redis"

  # Force Redis to publish a consistent snapshot before reading its volume.
  (
    cd "$APP_DIR"
    $COMPOSE_COMMAND exec -T redis redis-cli SAVE >/dev/null
    $COMPOSE_COMMAND exec -T redis tar -C /data -czf - . >"$TEMP_DIR/redis-data.tar.gz"
  ) || fail "snapshot Redis gagal"

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
