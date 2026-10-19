#!/usr/bin/env bash
# Enables hybrid post-quantum key exchange without exposing the live daemon to an
# untested config. Candidate config is validated on a temporary sshd first.
set -Eeuo pipefail

DROP_IN="/etc/ssh/sshd_config.d/10-motion-studio-pq.conf"
PROBE_PORT="${PROBE_PORT:-2222}"
PROBE_CONFIG="/run/sshd-pq-probe.conf"
PROBE_PIDFILE="/run/sshd-pq-probe.pid"
CANDIDATE="/run/sshd-motion-studio-pq.candidate"
PREVIOUS="/run/sshd-motion-studio-pq.previous"
KEX_ALGORITHMS="mlkem768x25519-sha256,sntrup761x25519-sha512,sntrup761x25519-sha512@openssh.com,curve25519-sha256,curve25519-sha256@libssh.org,ecdh-sha2-nistp256,ecdh-sha2-nistp384,ecdh-sha2-nistp521,diffie-hellman-group-exchange-sha256,diffie-hellman-group16-sha512,diffie-hellman-group18-sha512"

# 1 once the live drop-in has been replaced, 0 while production is still untouched.
LIVE_INSTALLED=0
PREVIOUS_SAVED=0
PREVIOUS_KEPT=0

fail() {
  printf 'SSH hardening gagal: %s\n' "$1" >&2
  exit 1
}

cleanup_probe() {
  if sudo test -f "$PROBE_PIDFILE"; then
    sudo kill "$(sudo cat "$PROBE_PIDFILE")" 2>/dev/null || true
  fi
  sudo rm -f "$PROBE_PIDFILE" "$PROBE_CONFIG"
}

restore_previous_drop_in() {
  if [[ "$PREVIOUS_SAVED" == "1" ]]; then
    sudo install -o root -g root -m 600 "$PREVIOUS" "$DROP_IN" || return 1
  else
    sudo rm -f "$DROP_IN" || return 1
  fi
}

# Nonzero means the daemon could not be returned to a valid previous state.
rollback_drop_in() {
  restore_previous_drop_in || return 1
  sudo sshd -t || return 1
  sudo systemctl reload sshd || return 1
  LIVE_INSTALLED=0
}

on_exit() {
  local status=$?
  cleanup_probe
  # A signal anywhere after the live file changed must still undo it - including the gap
  # between `install` and the explicit post-install checks.
  if [[ "$LIVE_INSTALLED" == "1" ]]; then
    if rollback_drop_in; then
      printf 'Drop-in sebelumnya dipulihkan.\n' >&2
    else
      if [[ "$PREVIOUS_SAVED" == "1" ]]; then
        PREVIOUS_KEPT=1
        printf 'SSH hardening gagal: konfigurasi sebelumnya tidak dapat dipulihkan; sshd mungkin masih memakai kandidat. Salinan konfigurasi lama disimpan di %s\n' "$PREVIOUS" >&2
      else
        printf 'SSH hardening gagal: konfigurasi sebelumnya tidak dapat dipulihkan; sshd mungkin masih memakai kandidat dan tidak ada drop-in lama\n' >&2
      fi
      status=1
    fi
  fi
  sudo rm -f "$CANDIDATE"
  if [[ "$PREVIOUS_KEPT" != "1" ]]; then
    sudo rm -f "$PREVIOUS"
  fi
  exit "$status"
}
trap on_exit EXIT
cleanup_probe

printf '%s\n' \
  '# Managed by Motion Studio deployment. Hybrid post-quantum KEX first.' \
  "KexAlgorithms ${KEX_ALGORITHMS}" \
  | sudo tee "$CANDIDATE" >/dev/null
sudo chmod 600 "$CANDIDATE"

# Minimal probe config cannot inherit production listeners, ports, PID files, Match
# blocks, or authentication policy. It only needs host-key defaults and the candidate
# KEX to prove the temporary loopback daemon can negotiate the requested algorithm.
printf '%s\n' \
  "Include ${CANDIDATE}" \
  "Port ${PROBE_PORT}" \
  'ListenAddress 127.0.0.1' \
  'ListenAddress ::1' \
  "PidFile ${PROBE_PIDFILE}" \
  | sudo tee "$PROBE_CONFIG" >/dev/null
sudo chmod 600 "$PROBE_CONFIG"
sudo sshd -t -f "$PROBE_CONFIG" || fail "konfigurasi kandidat sshd tidak valid"
sudo /usr/sbin/sshd -f "$PROBE_CONFIG" || fail "sshd uji gagal dijalankan"

# `sshd` without -D forks and the parent can exit 0 before the socket is bound. If
# anything else already holds the probe port, the negotiation below would be answered by
# that daemon and prove nothing about the candidate, so require our own PID to be alive.
sudo test -s "$PROBE_PIDFILE" || fail "sshd uji tidak menulis PID file"
if ! sudo kill -0 "$(sudo cat "$PROBE_PIDFILE")" 2>/dev/null; then
  fail "sshd uji tidak berjalan; port ${PROBE_PORT} mungkin sudah dipakai proses lain"
fi

NEGOTIATED="$(ssh -p "$PROBE_PORT" -o KexAlgorithms=mlkem768x25519-sha256 \
  -o PreferredAuthentications=none -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/dev/null -o BatchMode=yes -vvv localhost 2>&1 \
  | grep -m1 'kex: algorithm' || true)"
cleanup_probe

[[ "$NEGOTIATED" == *"mlkem768x25519-sha256"* ]] \
  || fail "hybrid PQ tidak dinegosiasikan (${NEGOTIATED:-tidak ada hasil})"

# Keep rollback bytes, atomically install the proven candidate, then validate the full
# production config. Any failure from here on is undone by the EXIT trap.
if sudo test -f "$DROP_IN"; then
  sudo cp --preserve=mode,ownership "$DROP_IN" "$PREVIOUS" || fail "gagal menyimpan drop-in sebelumnya"
  PREVIOUS_SAVED=1
fi
LIVE_INSTALLED=1
sudo install -o root -g root -m 600 "$CANDIDATE" "$DROP_IN" || fail "gagal memasang drop-in kandidat"

if ! sudo sshd -t || ! sudo systemctl reload sshd; then
  rollback_drop_in || fail "konfigurasi live gagal dan drop-in sebelumnya tidak dapat dipulihkan"
  fail "konfigurasi live gagal; drop-in sebelumnya dipulihkan"
fi

# A config that reloads but does not actually apply PQ is as bad as one that fails to
# parse, so it is rolled back the same way.
if ! sudo sshd -T | grep -q '^kexalgorithms .*mlkem768x25519-sha256'; then
  rollback_drop_in || fail "konfigurasi aktif tidak memuat PQ dan tidak dapat dipulihkan"
  fail "konfigurasi aktif tidak memuat PQ; drop-in sebelumnya dipulihkan"
fi

# Candidate is now proven live. Disarm rollback so normal script exit keeps it installed.
LIVE_INSTALLED=0
printf 'Negosiasi uji: %s\n' "$NEGOTIATED"
printf 'SSH post-quantum aktif.\n'
