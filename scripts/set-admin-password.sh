#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/var/www/app.bangalimin.com}"
ENV_FILE="${ENV_FILE:-${APP_DIR}/.env}"
COMPOSE_FILE="${COMPOSE_FILE:-${APP_DIR}/docker-compose.yml}"

fail() {
  printf 'Konfigurasi password admin gagal: %s\n' "$1" >&2
  exit 1
}

[[ -f "$ENV_FILE" ]] || fail "file .env tidak ditemukan di ${ENV_FILE}"
[[ -f "$COMPOSE_FILE" ]] || fail "docker-compose.yml tidak ditemukan di ${COMPOSE_FILE}"
command -v docker >/dev/null 2>&1 || fail "Docker tidak tersedia"

read -r -s -p 'Password admin baru (minimal 12 karakter): ' PASSWORD
printf '\n'
read -r -s -p 'Ulangi password admin: ' PASSWORD_CONFIRM
printf '\n'

[[ "$PASSWORD" == "$PASSWORD_CONFIRM" ]] || fail "konfirmasi password tidak cocok"
[[ ${#PASSWORD} -ge 12 ]] || fail "password minimal 12 karakter"

HASH="$(printf '%s' "$PASSWORD" | docker compose -f "$COMPOSE_FILE" run --rm --no-deps -T \
  vps-server node vps-server/scripts/hash-admin-password.js)" || fail "gagal membuat hash password"
unset PASSWORD PASSWORD_CONFIRM
[[ "$HASH" == scrypt\$v1\$* ]] || fail "hasil hash tidak valid"

TEMP_FILE="$(mktemp "${ENV_FILE}.XXXXXX")"
cleanup() {
  rm -f "$TEMP_FILE"
}
trap cleanup EXIT

awk -v hash="$HASH" '
  BEGIN {
    replaced = 0
    quote = sprintf("%c", 39)
  }
  /^ADMIN_PASSWORD_HASH=/ {
    print "ADMIN_PASSWORD_HASH=" quote hash quote
    replaced = 1
    next
  }
  { print }
  END {
    if (!replaced) print "ADMIN_PASSWORD_HASH=" quote hash quote
  }
' "$ENV_FILE" > "$TEMP_FILE"
chmod --reference="$ENV_FILE" "$TEMP_FILE"
chown --reference="$ENV_FILE" "$TEMP_FILE"
mv "$TEMP_FILE" "$ENV_FILE"
trap - EXIT

cd "$APP_DIR"
docker compose up -d --force-recreate --wait vps-server
printf 'Password admin aktif. Semua session lama otomatis tidak berlaku.\n'
